# Legal sign-off gate

The production pipeline's `LegalSignoffGuard` step runs
`node scripts/assert-legal-signoff.mjs` and fails unless a sign-off record
exists at `legal-signoff/prod-approval.json`.

Counsel (or the owner on counsel's written instruction) commits the record
once the release's legal review is complete. The file is deliberately a
plain JSON manifest committed to the repo so the approval trail is versioned
with the release it covers.

## Record shape

```json
{
  "approvedBy": "counsel name or firm",
  "approvedAt": "YYYY-MM-DD",
  "scope": "what was reviewed (e.g. 'GA terms, privacy policy v1.2')",
  "notes": "optional — reference to the sign-off artifact"
}
```

`prod-approval.example.json` shows a filled-in example — copy it to
`prod-approval.json` and fill in the real values. Do not commit the example
values as the real record: the guard checks shape only, so a copied example
would satisfy the gate without an actual review.
