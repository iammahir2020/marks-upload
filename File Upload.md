# Feature: Excel-based Exam Marks Workflow (Frontend, React PWA)

## Overview
Replace/extend the current Excel export with a round-trip workflow: user uploads
an Excel workbook containing a student roster (and possibly prior exam
sheets already in it), the app runs the existing OCR/marks-extraction
pipeline, writes a new sheet into that same workbook named after the exam,
and the user downloads the updated file. Next exam, they re-upload the same
file and the process repeats, accumulating one sheet per exam.

Runs entirely client-side for the spreadsheet handling. No backend changes
needed for this feature (OCR/vision calls stay wherever they currently run).

## Goals
- Upload an .xlsx file, extract the student roster from it
- Run existing marks-extraction pipeline, matched against roster IDs
- Let user review/edit extracted marks before writing (existing review step)
- Write results as a new sheet named after the exam (from setup screen input)
- Preserve every other sheet already in the workbook untouched
- Trigger a download of the updated workbook

## Non-goals
- No Google Sheets / Drive integration (decided against — see prior discussion)
- No backend storage of uploaded files — process in-browser, discard after download
- No multi-user auth/accounts in this feature
- Not solving arbitrary/unstructured spreadsheet formats — a defined contract is required (below)

## File Format Contract

**Roster sheet**
- Identified by content, not name or position: the sheet whose header row
  contains BOTH `STUDENT ID` and `STUDENT NAME` (case-insensitive). Matches
  the real template already in use, named `data`, with columns `SL`,
  `STUDENT ID`, `STUDENT NAME`.
- Requiring both columns (not just `STUDENT ID`) is what keeps this from
  accidentally matching an exam sheet once several have accumulated — exam
  sheets carry `STUDENT ID` but not `STUDENT NAME`.
- Do NOT rely on sheet name or sheet position — a user reordering tabs in
  Excel would silently break either assumption; content-based lookup survives it.
- If no sheet matches, show a validation error.
- `SL` is read-through but not required by this feature.

**Exam sheets**
- One per exam, named after the exam name entered on the setup screen
- Columns: `STUDENT ID`, `Marks` (extend later if needed, e.g. `Notes`)
- Existing exam sheets are never modified when writing a new one

**Sheet name sanitization** (Excel hard limits — enforce before writing)
- Max 31 characters — truncate with a warning if the exam name exceeds this
- Strip/replace disallowed characters: `: \ / ? * [ ]`
- Reject or auto-rename if sanitized name is empty, or if it collides with the roster sheet's actual name

## User Flow
1. Setup screen: user types exam name (e.g. "Quiz 1")
2. Upload screen: user selects the .xlsx file
3. App validates the file against the format contract (below) — show clear
   error and block progress if invalid
4. App locates the roster sheet by content (see contract below) and extracts the `STUDENT ID` list
5. Existing OCR/vision pipeline runs, producing `{studentId, marks}` results
6. Review/edit table shown (existing step) — user can correct mismatches before export
7. On confirm: check if a sheet with the sanitized exam name already exists
   - If yes: prompt user — Overwrite / Rename (auto-suffix e.g. "Quiz 1 (2)") / Cancel
8. App writes the new sheet into the in-memory workbook, preserving all others
9. Trigger download of updated .xlsx (same original filename, or user-editable)

## Component Breakdown
- `ExamSetupForm` — captures exam name, passes sanitized name downstream
- `FileUpload` — accepts .xlsx, reads via `FileReader`/`file.arrayBuffer()`
- `WorkbookValidator` — scans all sheets for one with `STUDENT ID` +
  `STUDENT NAME` columns, returns parsed roster or a validation error object
- `MarksReviewTable` — existing review/edit UI, reused as-is; consumes
  OCR/vision output + roster, outputs confirmed `{studentId, marks}[]`
- `SheetWriter` — takes workbook + exam name + confirmed results, handles
  name collision prompt, writes new sheet, returns updated workbook
- `DownloadTrigger` — calls `XLSX.writeFile` (or File System Access API path,
  see below) to hand the file back to the user

## Technical Implementation

**Library:** `xlsx` (SheetJS) — `npm install xlsx`

**Reading the upload**
```javascript
import * as XLSX from 'xlsx';

const buffer = await file.arrayBuffer();
const workbook = XLSX.read(buffer, { type: 'array' });
```

**Finding and validating the roster (content-based, not name/position-based)**
```javascript
function findRosterSheet(workbook) {
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name]);
    if (rows.length === 0) continue;
    const headers = Object.keys(rows[0]).map(k => k.trim().toUpperCase());
    if (headers.includes('STUDENT ID') && headers.includes('STUDENT NAME')) {
      return { name, rows };
    }
  }
  return null; // no roster sheet found -> validation error
}
```

**Writing the exam sheet + collision handling**
```javascript
function sanitizeSheetName(name) {
  return name.replace(/[:\\/?*\[\]]/g, '').slice(0, 31).trim();
}

function writeExamSheet(workbook, examName, results) {
  const safeName = sanitizeSheetName(examName);
  let finalName = safeName;

  if (workbook.SheetNames.includes(safeName)) {
    // caller resolves this via user prompt before calling writeExamSheet:
    // overwrite -> delete existing sheet first
    // rename -> auto-suffix, e.g. finalName = `${safeName} (2)`
  }

  const ws = XLSX.utils.json_to_sheet(results); // [{ 'STUDENT ID': ..., Marks: ... }]
  XLSX.utils.book_append_sheet(workbook, ws, finalName);
  return workbook;
}
```

**Triggering download**
```javascript
XLSX.writeFile(workbook, file.name); // reuses original filename
```

**Optional upgrade — File System Access API**
For Chromium browsers (Chrome, Edge — no Safari/Firefox support), use
`showOpenFilePicker()` / `getFile()` + `createWritable()` to read and write
the same file on disk without a manual re-upload/re-download cycle each
time. Treat as a progressive enhancement, not the primary path, given
partial browser support.

## Validation & Error Handling
- No sheet with both `STUDENT ID` and `STUDENT NAME` columns → block upload, show specific error
- Empty roster (headers only, no rows) → block, show error
- Exam name sanitizes to empty string → block at setup screen, ask for a valid name
- Sheet name collision → explicit user choice (overwrite/rename/cancel), never silent overwrite
- Corrupt/non-xlsx file → catch `XLSX.read` exceptions, show generic "couldn't read this file" error

## Edge Cases to Handle
- Student in OCR results but not in roster (typo, new student) — surface in review table, don't silently drop
- Student in roster with no matching OCR result (absent, illegible script) — leave blank/flag in review table, don't block export
- Re-upload of a file that already has the current exam's sheet — handled by collision prompt above
- Very long exam names — truncated per sanitization, warn user in UI what the final sheet name will be

## Out of Scope (for this pass)
- Google Sheets / Drive sync
- Backend persistence of uploaded/generated files
- Multi-tenant roster management across exams (roster edits mid-term are manual, in the spreadsheet itself)

## Suggested Build Order
1. `WorkbookValidator` + upload UI + error states
2. `SheetWriter` + sanitization + collision handling (unit-testable in isolation, no UI needed yet)
3. Wire into existing OCR pipeline + review table
4. Download trigger
5. (Optional) File System Access API upgrade path