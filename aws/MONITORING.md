# Watching the app in CloudWatch

The backend emits one JSON object per line to stdout. Lambda captures
stdout into `/aws/lambda/marks-scanner-api` with no agent and no config, so
these queries work the moment the function is deployed.

A real scan line looks like this:

```json
{"event":"scan","status":"ok","failure_reason":null,"recognizer":"cnn",
 "questions":5,"id_digits":7,"image_kb":66,
 "ms_detect":85,"ms_read_id":13,"ms_read_marks":27,"ms_total":126,
 "flagged_count":1,"flagged":["q1"]}
```

**What is deliberately absent: the student ID, the serial, and every mark
value.** `flagged` carries field *names*, which is the useful half and none
of the sensitive one. See `app/observability.py` for how that is enforced,
and `tests/test_observability.py` for the test that reads real emitted
output and fails if a recognised ID appears in it.

## The deployed stack, and which part to look at

```
phone ──► CloudFront ──┬──► S3 (frontend)
   d2n2meq17rr1oi.cloudfront.net
                       └──► API Gateway ──► Lambda ──► S3 (crops)
                            /api/*          marks-scanner-api
```

- **Watching a live scan** — CloudWatch → Log groups →
  `/aws/lambda/marks-scanner-api`. This is where a scan actually happens,
  and where your structured `scan` events land. **Start here.**
- **Queries** — CloudWatch → Logs Insights, pick that log group
- **Built-in metrics** — Lambda → `marks-scanner-api` → Monitor tab
  (invocations, errors, duration, throttles — free, no setup)
- **Requests that never reached Lambda** — API Gateway → APIs →
  `marks-scanner-api` → Monitor. A 5xx here with nothing in the Lambda log
  group means the request died before invocation (a missing invoke
  permission does exactly this, and looks like a bare "Internal Server
  Error").
- **Traffic and errors at the edge** — CloudFront → `E31IWW3STVXMSN` →
  Monitoring. Useful for "is anyone hitting it at all".
- **Crops arriving** — S3 → `marks-scanner-crops-105322541848` →
  `harvested/<source-id>/…`, one prefix per faculty browser.

### Watching a scan happen, live

CloudWatch → Log groups → `/aws/lambda/marks-scanner-api` → **Live tail**
(button at the top). Start it, then scan on your phone. You will see, in
order: the uvicorn request line, your `{"event":"scan",...}` JSON, and
Lambda's `REPORT` line with duration and memory.

Live tail is billed per minute of streaming, so stop it when you are done
rather than leaving it open.

## Queries worth saving

Logs Insights parses these fields automatically because the lines are real
JSON. Save each one (**Save** button) so they are one click away mid-class.

**Every scan, newest first — the general-purpose view**

```
fields @timestamp, status, failure_reason, ms_total, flagged_count, image_kb
| filter event = "scan"
| sort @timestamp desc
| limit 50
```

**Is it working? Success rate and failure reasons**

```
fields @timestamp
| filter event = "scan"
| stats count() as scans,
        sum(status = "failed") as failed,
        sum(status = "failed") * 100 / count() as pct_failed
        by bin(1h)
```

```
fields @timestamp
| filter event = "scan" and status = "failed"
| stats count() as n by failure_reason
| sort n desc
```

`table_not_found` and `column_count_mismatch` dominating is a framing or
template problem, not a bug — the detector refusing to guess.

**Where is the time going? (the reason stage timings exist)**

```
fields @timestamp
| filter event = "scan"
| stats avg(ms_detect) as detect, avg(ms_read_id) as id,
        avg(ms_read_marks) as marks, avg(ms_total) as total,
        pct(ms_total, 95) as p95
        by bin(15m)
```

"Scans are slow" is unactionable. "Detection is 2.1 s and recognition is
0.2 s" points straight at the cause. Compare against the laptop baseline —
detect ~85 ms, read_id ~13 ms, read_marks ~27 ms on a real 1920×1080
capture — to see what Lambda's slower vCPU actually costs.

**Which fields does the model struggle with?**

```
fields @timestamp
| filter event = "scan" and flagged_count > 0
| stats count() as n by flagged.0
| sort n desc
```

Expect `serial` near the top — it is the known weak field at 63.2%.
A field climbing here is a real accuracy regression, and this is the
only place it would show up before someone complains.

**Cold starts** — measured at ~9s on this function, not the 2-4s
originally estimated from a laptop emulator. The deploy's warm-up exists
because of this number.

```
filter @type = "REPORT"
| fields @timestamp, @duration, @initDuration, @maxMemoryUsed
| filter ispresent(@initDuration)
| stats count() as cold_starts, avg(@initDuration) as avg_init_ms
```

`@initDuration` appears only on cold starts. Measured locally at ~1.26 s
under the runtime emulator; if production is far worse, the image pull is
the cause, not the code.

**Is 2 GB the right memory setting?**

```
filter @type = "REPORT"
| stats max(@maxMemoryUsed)/1000000 as peak_mb,
        avg(@billedDuration) as avg_billed_ms
```

Memory is also CPU on Lambda, so dropping it slows scans. Only reduce it if
peak is far below the setting *and* durations stay acceptable.

**Abuse and limits**

```
fields @timestamp, path, retry_after_s
| filter event in ["rate_limited", "rejected_oversize"]
| sort @timestamp desc
```

Steady `rate_limited` from ordinary use means the 30/min budget is too
tight — several faculty behind one institutional NAT share an apparent IP.
Raise `RATE_LIMIT_REQUESTS` rather than removing the limit.

**Is harvesting actually working?**

```
fields @timestamp, harvested, tagged
| filter event = "harvest"
| stats count() as calls, sum(harvested) as succeeded, sum(tagged) as with_source
```

`tagged` false means crops are landing under `unknown/` — the frontend is
not sending its source id, which quietly breaks held-out-writer evaluation.

## Keeping it free

- **Logs**: the always-free tier includes 5 GB/month ingestion. These lines
  are ~200 bytes, so a 30-script class is ~6 KB. Not a concern.
- **Set a retention period anyway.** New log groups default to *Never
  expire*, which is a slow privacy leak as much as a cost one:

  ```bash
  aws logs put-retention-policy \
    --log-group-name /aws/lambda/marks-scanner-api \
    --retention-in-days 30
  ```

- **Custom metrics are NOT free** beyond the first 10 ($0.30/metric/month).
  Logs Insights queries cost per GB scanned and at this volume round to
  nothing, so prefer queries over metric filters unless you want an alarm.
- **Dashboards**: first 3 are free. Pin the success-rate and stage-timing
  queries to one if you want a single page to glance at.

## One alarm worth having

Everything above is pull-based — useful when you go looking. If you want to
be told, the cheapest useful alarm is on Lambda's built-in `Errors` metric
(free, no custom metric needed): Lambda → Monitor → View in CloudWatch →
`Errors` → Create alarm, threshold `> 0` over 5 minutes.

That fires on unhandled exceptions — a crashed function — not on a scan
that legitimately returns `failed`, which is normal behaviour and not an
error.
