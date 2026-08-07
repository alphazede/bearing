---
type: design
status: complete
---

## Use Cases and Communication Flows

The owner dispatches one bounded import slice.

## Interface Option Check

Reuse the existing validation boundary; no new interface is needed.

## OOPDSA Implementation Design

- **DES-1** — Import module with a documented schema.
- **CONTRACT-1** — Import and validation agree on the ledger schema.

| Component | Decision |
| --- | --- |
| Import boundary | Reuse |
| Validation | Keep closed |
