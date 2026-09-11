# Procurement KT: post-award journey (PO to payment)

Status: knowledge-transfer notes · Last reviewed: 2026-09 · Audience: product and engineering · Source file: Copy of Procurement -KT.docx · Ingested: 2026-09-12

Knowledge-transfer notes on the procure-to-pay journey after sourcing: PO, quality checks, shipment, gate entry, receipt, invoice and 3-way match, plus PO amendment versions and the tax engine.

## Post-award journey

PR -> Sourcing -> Contract, PO, Vendor Portal, Vendor Onboarding -> PO Acknowledgement.

## Types of procurement (quality-check scenarios)

- Scenario A: quality check is required before dispatch at the supplier site.
- Scenario B: QA check is required at the plant.
- Scenario C: no QA check required.

Scenario A flow: Material manufacturing -> Ready -> Inspection Request raised (Supplier) -> Buyer QA / buyer third-party QA / self assessment at the supplier site -> Offline inspection -> QAN (Quality Acceptance Note, Buyer) -> Outcome: pass or fail, full pass or partial -> if failed, re-inspection request is raised whenever material is ready -> Inspection -> QAN -> Pass.

## Shipment, gate and receipt

- ASN: Advance Shipment Note, created by the Supplier.
- Invoice: created by the Supplier via the portal or offline.
- Plant -> Gate -> Gate Entry / Gate Inward / Gate Outward (buyer end).
- Primary user of the platform is the Buyer (they pay); the supplier side covers Gate Inward/Outward.
- GRN (Goods Receipt Note) / MRN (Material Receipt Note) / GR is done by the buyer's warehouse or store person, in SAP.
- QA check-in happens in SAP by the QA person.
- Invoice: posted on the portal, then digitised.

## Payments and 3-way match

What you ordered, what you received and what you invoiced are matched (3-way match, in Procol). On match the invoice is pushed to SAP -> payment is released in SAP -> payment details come back in the response -> visible to the vendor. This replaces the vendor's repeated follow-ups to check payment status.

## Who creates and who sees what

- Buyer-side creation: PO, Invoice, GRN, QAN, 3-way match.
- Buyer-side visibility: PO, Invoice, GRN, QAN, 3-way match, ASN, payment details.
- Supplier-side creation: ASN, Inspection Request, QAN, Invoice.
- Supplier-side visibility: PO, ASN, Inspection Request, QAN, Invoice, payment status.

## PO amendment flow (versions are maintained)

- Scenario 1: Submit -> In Approval -> edit -> submit -> re-approval run.
- Scenario 2: Submit -> In Approval -> Approved -> edit -> submit -> re-approval run.
- Scenario 3: Submit -> In Approval -> Approved -> Released -> edit -> submit -> re-approval run -> re-release -> the vendor sees the new version.

## Custom tax engine

- Current: inter/intra state is decided from the supplier and buyer locations, which gives the tax percentage.
- New: a configurable rule engine, independent per tenant (for example Gmmco-wise), using: classification (taxable under GST, GST-exempted, non-taxable), vendor classification, type of procurement (goods, service, asset, RCM and so on) and the HSN code of the material. These parameters identify the tax code -> tax % -> IGST, SGST, CGST.

## Feature checklist covered in the KT

Vendor onboarding, BOQ, Intake, NFA, Material codification, Evaluation, Re-evaluation, Amendment (event update), Template creation, Multimake (new), Partial awarding, Scoring (new), Invoice OCR, Amendment, Contract, ASN, PO, CN (credit note), DN (debit note), Discrepancy, Bulk upload, QAN, Inspection request, Proforma invoice, CBD, Fast bidding, Lot based, Line based, Surrogate bid, PR, Sourcing, Bidding, Counter offer, Revision, Normal bid, Awarding, Price capping as surrogate bid, Event to PO, PO to Bill, 3-way match. Test accounts mentioned: Procol test vendor, Larsen and Toubro.
