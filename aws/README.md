# A dedicated IAM user for deploying this project

`deploy-policy.json` is the least-privilege policy `./deploy.sh` actually
needs — derived from the API calls the script makes, not from a guess.

Every ARN in it contains the literal `ACCOUNT_ID`, which the commands below
substitute. Names match `deploy.sh`'s defaults (`marks-scanner`); if you
override `PROJECT`, update the resource ARNs to match or the deploy will
fail with `AccessDenied` on a name the policy doesn't cover.

## Create the user

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" aws/deploy-policy.json > /tmp/marks-deploy-policy.json

aws iam create-user --user-name marks-scanner-deploy

aws iam put-user-policy \
  --user-name marks-scanner-deploy \
  --policy-name marks-scanner-deploy \
  --policy-document file:///tmp/marks-deploy-policy.json

# Prints the only copy of the secret you will ever get.
aws iam create-access-key --user-name marks-scanner-deploy
```

Then put the key in its own profile rather than overwriting your default:

```bash
aws configure --profile marks-scanner
AWS_PROFILE=marks-scanner ./preflight.sh
AWS_PROFILE=marks-scanner ./deploy.sh backend
```

## What each grant is for, and which ones are load-bearing

| Grant | Why | Scope |
|---|---|---|
| `ecr:GetAuthorizationToken` | `docker login` to ECR | Account-wide — AWS does not allow scoping this one |
| ECR repo actions | create the repo, push image layers | One repo |
| Lambda actions | create/update the function, set its config and invoke permission | One function |
| API Gateway actions | create the HTTP API that fronts the function | Account-wide — see below |
| `iam:CreateRole` + `PutRolePolicy` | create the function's execution role | One role |
| **`iam:PassRole`** | hand that role to Lambda at create time | **One role, and only to `lambda.amazonaws.com`** |
| S3 bucket actions | create the crops and site buckets, upload the frontend | Two buckets |
| CloudFront actions | the distribution that gives the site real HTTPS | Account-wide — see below |

The policy also still carries `lambda:*FunctionUrlConfig`. Those are
**dead grants** — `deploy.sh` made Function URL calls in an earlier design
that this account would not support (see the API Gateway note in
`deploy.sh`), and it makes none now. Same for the
`CloudFrontFunctionForSigningApiPostBodies` statement, left from the
abandoned request-signing approach. Both should be removed; they are
recorded in issues.md as N12 rather than deleted silently, since "the
policy is derived from the calls the script actually makes" is a claim
this file makes and they are the counterexamples.

### The three grants that are wider than they look

**`iam:PassRole` is the one to understand.** It means "let this user attach
a role to a service". Unscoped, it is close to privilege escalation: anyone
holding it could hand a powerful role to a service they control. Here it is
pinned to a single role ARN *and* conditioned on
`iam:PassedToService: lambda.amazonaws.com`, so it can only ever be used to
give this project's own execution role to Lambda. Do not relax either half.

**CloudFront cannot be resource-scoped on create.** A distribution's ARN
does not exist until it has been created, so `CreateDistribution` has to be
`Resource: "*"`. This is an AWS limitation, not laziness. It is among the
widest grants here, and the reason a separate user is worth the effort
rather than adding CloudFront to a user that does other work.

**API Gateway has the same problem, and it is worth naming.** The
statement is scoped to `arn:aws:apigateway:*::/apis` and `/apis/*`, which
reads narrow and is not: `/apis` is where a *new* API is created (so it
cannot be pinned to one that does not exist yet), and `/apis/*` with
`PATCH`/`PUT` covers **every API Gateway API in the account** — this user
could re-target or reconfigure an unrelated one. Today this account has
only this project's API, so the practical exposure is nil, but that is a
property of the account rather than of the policy. If this key is ever
used somewhere with other APIs, scope `/apis/*` down to the created API's
id after the first deploy.

### What is deliberately absent

- **No delete permissions** beyond `DeleteObject` (needed by `s3 sync
  --delete` for the frontend) and `lambda:DeleteFunction`. This user cannot
  delete a bucket, a repository, or a role.
- **It CAN read the crops bucket** (`s3:GetObject`), which is a deliberate
  convenience rather than an oversight: it lets
  `AWS_PROFILE=marks-scanner ./fetch-crops.sh s3 <bucket>` pull training
  data without reaching for admin credentials. The trade is that this key
  can download every collected crop. That is student handwriting, so if you
  would rather it couldn't, drop `s3:GetObject` and `s3:DeleteObject` from
  the crops bucket ARNs (the site bucket still needs both for `s3 sync`)
  and pull with your own credentials instead.
- **No billing or account access.** The plan change and budget alarm in
  step 11.6.0 are console actions on the root/admin account.

## The execution role is a different thing

`deploy.sh` creates `marks-scanner-lambda-role` for the *running function*,
which gets only:

- `AWSLambdaBasicExecutionRole` (CloudWatch Logs), and
- `s3:PutObject` on the crops bucket — **write-only, no read, no list**.

That asymmetry is deliberate: the function appends harvested crops and
never needs to read them back, so a compromised function cannot be used to
download what it has already collected.
