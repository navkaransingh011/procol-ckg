# Ticket triage for CS

Paste a customer complaint (or switch the composer to **Ticket** mode) and the agent answers one question first:
**who can resolve this**, with the facts that say so.

## The card

| Section | Comes from |
|---|---|
| Customer and company ids | the name in the ticket resolved against the platform's companies (`config/tenants.json` maps tenant words) |
| Trying to do / likely cause | the model, from the facts below only |
| Likely feature, with confidence | code hits vote for the feature that implements them (6,000 links); agreement across layers raises confidence |
| Settings that govern it | configuration switches matched by meaning, checked against whether the feature's code reads them, with the customer's **effective value** and its source (default / company master / override) |
| Guides, where in the product | document passages and dashboard screens with their buttons |
| Who to ask | owners of the feature's code from commit history; the guide's owner for the process |
| Verdict | one of four, chosen by the model **only from what the facts allow** |

## Verdicts

- **knowledge** (CS can resolve): allowed when a guide or a screen covers the ask. Comes with a reply draft grounded in them.
- **config** (needs an admin): allowed when a governing switch has a known value for the customer. Names the switch; the agent never changes it.
- **engineering** (needs a developer): allowed when quoted error text was found in code, a defect sits on the path, a document and the code disagree, or the behaviour has no screen, action or switch anywhere. Comes with a handoff note.
- **more_info**: always allowed; comes with the questions to ask the customer.

A verdict the facts do not support is downgraded to more_info and the card says what the model proposed.

## Accuracy

Unmeasured until real tickets run through it. `eval/tickets.json` holds three written examples; replace them with
twenty anonymised tickets whose outcome is known (CS answered / admin flipped a switch / developer fixed) and run:

```bash
node --env-file=.env src/eval-triage.mjs --role cs
```

Every card has 👍 / 👎; the votes land in `ckg.triage_feedback` and become the ongoing calibration set.

## Privacy

Tickets carry customer names and contacts. Emails and phone numbers are masked before the question is saved in the
chat. Tickets are never mirrored from HubSpot; a future ticket-number lookup fetches one ticket on demand.

## Roles

The same card, filtered by role: CS sees features, screens, switches, guides and owners; file paths and code names are
removed on the way out, as for every other answer.
