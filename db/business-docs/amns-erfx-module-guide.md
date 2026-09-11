# AMNS eRFX module: complete feature, process and integration guide

Status: current · Last reviewed: 2026-08-31 (v2.0) · Audience: AM/NS India procurement and sourcing team; Procol CS · Source file: AMNS_DOC_AD.docx · Ingested: 2026-09-12

AM/NS India (ArcelorMittal Nippon Steel India)

*This document covers every feature of the Procol eRFX module — from PR intake via SAP integration through RFP, RFQ, and all auction formats (British, Dutch, Knockout, Traffic Light), lot splitting, hold/unhold, cost breakdown, PO generation, and ERP integration. Written for internal training and reference.*

| Prepared for | AM/NS India — Procurement & Sourcing Team |
| --- | --- |
| **Platform (Buyer)** | app.procol.in |
| **Platform (Vendor)** | trade.procol.in |
| **Classification** | Internal — Confidential |
| **Version** | 2.0 |
| **Date** | 31 August 2026 |

# Table of Contents

1. Platform Overview & Access

2. Key Concepts & Terminology

3. Intake — Purchase Requisition (PR) from AMNS SAP

4. PR Hold / Unhold — Rules & Workflow

5. Creating a Sourcing Event from a PR

6. Event Types — RFP, RFQ & Auction

7. Event Combinations

8. Lot Splitting (Material PRs Only)

9. Step-by-Step: Creating an RFQ

10. Step-by-Step: Creating an Auction (Auction Team)

11. Open Tender

12. E-Auction Formats — British Reverse Auction

13. E-Auction Formats — Dutch Auction

14. E-Auction Formats — Knockout (Japanese) Auction

15. E-Auction Formats — Traffic Light Auction

16. Choosing the Right Auction Format

17. Event Tracking — Live & History Tabs

18. Awarding — Master QCS (MQCS)

19. Cost Breakdown (CBD) After Live Auction (Before Award)

20. Purchase Order (PO) Generation & NFA Approval

21. ERP Integration — PR, PO & Master Data

22. Standalone Intake Request (NFA)

23. Standalone Auction & Surrogate Bids

24. Counter Offer Module

25. Event Management Actions

26. Vendor Guide — Vendor-Side Experience

27. Quick Reference Summary

# 1. Platform Overview & Access

## What is the Procol eRFX Module?

The eRFX module is the core sourcing engine of the Procol platform used by AM/NS India. It takes a business requirement from the moment it is raised as a Purchase Requisition (PR) in AMNS's SAP system, carries it through one or more competitive sourcing events — technical evaluation (RFP), quotation (RFQ), and/or live auctions — and closes the loop by awarding the vendor and generating a Purchase Order (PO) that is pushed back to SAP.

This creates a complete, auditable, digital procurement chain: SAP PR → Procol Event → Competitive Bidding → Award → Procol PO → SAP PO.

| Item | Details |
| --- | --- |
| **Buyer Portal** | app.procol.in — used by AM/NS India buyers, category managers, and the auction team |
| **Vendor Portal** | trade.procol.in — used by invited or open-tender vendors to submit bids |
| **PR Source** | AMNS SAP (S4 Hana) — PRs flow automatically into Procol via API integration |
| **PO Destination** | AMNS SAP — once approved in Procol, PO data is pushed back to SAP via API |
| **User Roles** | Member → Manager → Admin. Each user is mapped to a team → category → sub-category. |
| **Data Scope** | Users see only data for their mapped category/sub-category — cross-category access is restricted. |

| End-to-End Flow |
| --- |
| SAP PR → RFP (Technical Evaluation) → RFQ (Quotation) → Auction (Live Bidding) → CBD (Cost Breakdown) → Award (Master QCS) → PO Creation → NFA Approval → SAP PO |

# 2. Key Concepts & Terminology

A glossary of every term encountered in the eRFX module, organized by category.

## Sourcing Event Terms

| Term | Meaning |
| --- | --- |
| **PR (Purchase Requisition)** | The documented need for a material or service, raised in AMNS SAP and auto-pushed to Procol. The PR is the mandatory starting point for every sourcing event. |
| **RFP (Request for Proposal)** | Technical evaluation stage — vendors submit proposals covering qualifications, certifications, and capability. Evaluators score responses. Can be Line Item-based or Vendor-based. |
| **RFQ (Request for Quotation)** | Commercial quotation stage — vendors submit unit prices, delivery terms, and other commercial details for specific line items. |
| **Auction** | A live, time-bound competitive bidding event. Formats: British Reverse (rank-on-line), Dutch, Knockout (Japanese), Traffic Light. Run as a separate stage or after an RFQ. |
| **Event** | Any active sourcing activity in Procol — an RFP, RFQ, or Auction (or a combination). |
| **Lot** | A sub-group of line items within an event. After bids are received, an event can be split into multiple lots, each covering a different combination of line items. Further sourcing/awarding actions are taken lot by lot. |
| **NFA (Note for Approval)** | The approval document submitted for either PR creation or PO generation. Both require all configured approvers to approve before the PR/PO is created. |
| **Master QCS (MQCS)** | Master Quote Comparison Sheet — the final comparison view showing all vendor bids side by side. Used to make and record the award decision. |
| **CBD (Cost Breakdown)** | After the live auction ends (and before awarding), the winning vendor breaks down the total bid price into predefined cost components (e.g. materials, labour, overhead). The vendor can adjust the ratio and submit. CBD is completed prior to the award decision. |
| **Counter Offer** | A buyer's response to a vendor's submitted bid, proposing a different price or quantity (during live event or at evaluation time). Note: counter offers for quantity changes have been discontinued — quantity changes now create a new event version. |
| **Line Item** | An individual material or service in an event, sourced from the PR. Each line item has a material code, quantity, UOM, and location. |

## User & Process Terms

| Term | Meaning |
| --- | --- |
| **Buyer** | AM/NS India team member who creates and manages sourcing events. Mapped to specific categories. |
| **Auction Team** | Dedicated Procol users who take RFQ/Auction drafts created by buyers and officially publish them as live auction events. |
| **Evaluator** | Person assigned to score vendor RFP responses. Can be an internal expert or category manager. |
| **Vendor / Supplier** | Company or individual invited to bid. Accesses events via trade.procol.in. |
| **Open Tender** | An event published publicly — any mapped (pre-registered) vendor OR any vendor invited by name can participate, not just a pre-selected closed list. |
| **Hold** | A status where an event is paused due to internal changes (e.g. PR value updates). Vendors see a hold notice; they cannot submit bids. |
| **Unhold** | Releasing an event from Hold status after the required changes are complete. All line items must be repushed before the event becomes active again. |
| **Versioning** | When a quantity change occurs, a new version of the event is created (rather than editing the existing one). Both buyer and vendor see version history. |

# 3. Intake — Purchase Requisition (PR) from AMNS SAP

## How PRs Reach Procol

AM/NS India does not create PRs manually in Procol. All PRs are raised in AMNS SAP (S4 Hana) and pushed to Procol automatically via API integration. This eliminates duplicate data entry and ensures the PR in Procol is always in sync with the SAP source of truth.

| SAP → Procol PR Integration Summary |
| --- |
| When a PR is raised and approved in AMNS SAP, the PR data (item details, category, quantity, plant, T-codes, etc.) flows into Procol via a real-time API push. Procol processes the data, checks for anomalies, and — if clean — creates the PR record in the platform with a unique Procol PR code. If anomalies are found, they are flagged back to SAP for correction. Buyers in Procol then see the PR on their intake dashboard and can initiate a sourcing event directly against it. |

## What a PR Contains

| PR Field | Details |
| --- | --- |
| **Item name / Material code** | The material or service being procured, from the SAP material master |
| **Category / Sub-category** | The procurement category this PR falls under — determines which buyer team handles it |
| **Plant / Location** | The AMNS plant or location where the material/service is required |
| **Quantity & UOM** | Quantity requested and unit of measure (tonnes, numbers, etc.) |
| **PR Number** | Unique SAP PR number, carried into Procol for cross-system tracking |
| **Reference Price** | Optional: historical price or budget price attached to the line item, used for savings calculation |
| **Short Text / Item Text** | Descriptive text from SAP — appears in the Procol event for vendor reference. These are among the 5 validated fields for Hold/Unhold. |
| **Specification Text** | Technical specification text from SAP — also a validated field for Hold/Unhold. |
| **Attachments** | Links to documents (drawings, specs, DOR) attached at PR level in SAP, brought into Procol. |

## Material PR vs Service PR

Every PR in AMNS is classified as either a Material PR or a Service PR. This distinction controls which features are available downstream in the sourcing event.

| Aspect | Details |
| --- | --- |
| **Material PR** | PR for physical goods, components, or consumables sourced from external vendors. Supports all sourcing event features including Lot Splitting. |
| **Service PR** | PR for services (maintenance, contracting, consulting, etc.). Follows the same intake and sourcing flow but does NOT support Lot Splitting — this feature is available only for Material PRs. |
| **Lot Splitting restriction** | Lot splitting after bids are received is available ONLY for Material PRs. Service PRs cannot be split into lots. |
| **PR type field** | The PR type (Material or Service) is sent from SAP as part of the PR data and is visible in the Procol PR record. Buyers should verify this before configuring sourcing events. |

## PR Approval Flow (NFA)

While most PRs for AM/NS India flow from SAP (pre-approved), PRs that originate within Procol follow an NFA approval flow:

| 1 | Select template and fill PR fields** The requester chooses the correct PR template and fills all mandatory fields. |
| --- | --- |
| **2** | **Submit as NFA (Note for Approval)** The filled PR is submitted, triggering the configured approval workflow. |
| **3** | **Approvers review** Each approver in the flow is notified. They review and either approve or reject. |
| **4** | **PR is created** Only after all approvers have approved does the PR record become officially created in Procol. |
| **Note** | **Regardless of origin (SAP push or manual Procol entry), the PR is the single source of truth for all downstream sourcing. Item, category, quantity, and location details from the PR carry forward unchanged into the sourcing event.** |

# 4. PR Hold / Unhold — Rules & Workflow

The Hold/Unhold mechanism allows buyers to pause an active event when internal changes are needed (such as a PR value update, quantity revision, or scope change). This ensures no bids are submitted against an outdated or incorrect PR before the changes are finalized.

## Fields Validated During Hold/Unhold

Only the following 5 fields are validated during the Hold/Unhold phase (Phase 1). All other fields are ignored in this phase:

| Field | Description |
| --- | --- |
| **1. Quantity** | The requested quantity for the line item. If changed, a new event version is created. |
| **2. Budget** | The PR budget/reference price. Changes here may trigger NFA re-initiation. |
| **3. shortText** | The short description text from SAP (material/service short name). |
| **4. specificationText** | The technical specification text attached to the PR line item. |
| **5. itemText** | The detailed item text from SAP describing the requirement. |

## Hold Rules

| When Can an Event be Put on Hold? |
| --- |
| Events can be put on hold at any point while the NFA is still in progress.Events CANNOT be put on hold once the NFA has been Approved (i.e., when the event is in "PO Failed" or "PO Success" status). At that stage, the procurement is complete or committed.If an event is put on hold after a Counter Offer has been sent, the system will automatically stop or revoke: Submission timers, Counter Offers, NFAs, and Best Offer Time. |

## What Happens When a Hold is Placed

| 1 | Buyer initiates Hold** The buyer places the event on Hold in Procol, triggering the hold logic. |
| --- | --- |
| **2** | **System auto-revokes active processes** Any in-progress submission timers, counter offers, NFAs, and Best Offer Time windows are automatically revoked/stopped. |
| **3** | **NFA is auto-revoked** If an NFA was in progress, it is automatically revoked. It must be re-initiated after the required changes are made. |
| **4** | **Vendor sees Hold notice** Vendors on the event see the message: "This event is currently on hold due to internal changes. You will be notified once it becomes active again." |
| **5** | **Changes are made** The buyer (or SAP) makes the necessary changes to the PR — e.g. updated quantity, budget revision, or text corrections. |
| **6** | **All line items repushed** Before the event can be unheld, ALL line items within the event must be repushed (re-synced from SAP). This is a mandatory requirement — partial repush is not accepted. |
| **7** | **Unhold the event** Once all line items are repushed and validated, the buyer unholds the event. |
| **8** | **Evaluation resumes** Upon Unhold, evaluation resumes automatically from where it left off. Exception: TCS (Tax Collected at Source) evaluation is not part of this auto-resume logic. |
| **9** | **NFA re-initiated (if needed)** If the NFA was revoked, it must be re-initiated after the PR changes are complete. |

## Quantity Change — New Event Version

| Important: Quantity Changes Create New Versions |
| --- |
| Quantity changes through Counter Offer are discontinued. If a quantity change is required on any line item, a new event version is automatically created in Procol. Vendor-side Event Versioning: Vendors see both the old and new version of the event, clearly labeled, with version history. Vendor-side Bid Versioning: Bids submitted against a previous version are also versioned — vendors are clearly shown which version their bid corresponds to. |

## Lot Interaction with Hold

| Lot Handling |
| --- |
| Lot functionality is out of scope for Phase 1 of Hold/Unhold.If an event contains split lots, individual line items cannot be put on hold in Phase 1.Lot Withdrawal should be tested separately as it has its own workflow. |

# 5. Creating a Sourcing Event from a PR

Once a PR exists in Procol (whether pushed from SAP or created manually), the buyer creates a sourcing event — an RFx — against it. The PR details (items, quantities, locations) are automatically pulled into the event, so buyers do not re-enter item data.

| Step | What Happens |
| --- | --- |
| **Step 1: Select the PR** | From the Intake screen, the buyer selects the PR(s) to source against. Multiple PRs can be collated into a single event (e.g. three 2-line PRs → one 6-line RFQ). |
| **Step 2: Choose Event Type** | Select the event type: RFP (technical evaluation), RFQ (quotation), Auction, or a combination. See Section 6. |
| **Step 3: Add Vendors** | Invite specific vendors (closed tender) or publish as Open Tender for any mapped vendor to participate. See Section 11. |
| **Step 4: Configure & Publish** | Set template, add T&C, schedule the event. The buyer creates the event; for Auctions, the Auction Team takes over the publishing step. |

| Auction Team Workflow |
| --- |
| For auction events, the buyer creates and configures the event but saves it as a draft. The Auction Team (a dedicated Procol user group) then reviews the draft, makes any final configuration adjustments, and officially publishes the auction as live. This separation ensures all auction events are reviewed by specialists before going live to vendors. |

# 6. Event Types — RFP, RFQ & Auction

## 6.1 RFP — Request for Proposal (Technical Stage)

The RFP stage is used to technically evaluate vendors before any commercial sourcing begins. It qualifies vendors on technical and quality parameters. Each vendor must fill in technical answers for all line items in the event.

| Aspect | Details |
| --- | --- |
| **Purpose** | Assess vendor capabilities: qualifications, certifications, capacity, past experience, technical compliance for each line item in the event. |
| **Evaluation basis — Line Item** | Each line item is evaluated individually. Vendors submit technical answers per item. The evaluator scores each vendor per item separately. |
| **Evaluation basis — Vendor Lot** | Alternatively, the RFP can be run on a vendor basis for a single lot — the vendor is assessed as a whole entity (overall technical capability) rather than item by item. |
| **Template & Evaluator** | A template is selected defining the evaluation questionnaire. A technical evaluator is assigned to the event to score all vendor responses once submissions close. |
| **Vendor response options** | For each item, the vendor can either Submit a Response (fill in technical answers) or mark Regret (declining to bid on that item). A regretted item means the vendor will not participate in commercial bidding for that item. |
| **Evaluation scoring** | After the submission window closes, the evaluator reviews and scores each vendor response using a 4-level scale: T1 (top qualification), T2 (qualified), T3 (conditionally qualified), or TNA (Technically Not Acceptable). |
| **Outcome** | T1, T2, and T3 vendors proceed to the RFQ or Auction stage for commercial bidding. TNA vendors are excluded from all commercial stages. |

| Score / Status | Meaning |
| --- | --- |
| **T1** | Technically fully qualified — top tier. Eligible to proceed to commercial stage. |
| **T2** | Technically qualified — standard qualification. Eligible to proceed. |
| **T3** | Conditionally qualified — may proceed to commercial stage with conditions noted. |
| **TNA** | Technically Not Acceptable — vendor does NOT qualify. Cannot be awarded or proceed to commercial bidding. |
| **Regret** | Vendor has declined to bid on a specific item. Cannot be awarded for that item regardless of score. |

| Awarding Restriction |
| --- |
| Vendors scored TNA (Technically Not Acceptable) or who submitted Regret on a line item CANNOT be awarded for that item in the Master QCS. The system will not allow awarding to a TNA or Regretted vendor, even if their commercial price is the lowest. |

## 6.2 RFQ — Request for Quotation

The RFQ stage gathers competitive price quotes from a shortlisted set of vendors for specific goods or services. This is the commercial stage of sourcing.

| Aspect | Details |
| --- | --- |
| **Purpose** | Obtain competitive pricing and favorable commercial terms. Compare offers from multiple vendors on price, delivery, payment terms, taxes, and product specifications. |
| **Access** | Buyer portal: app.procol.in. Shortcut to create new event: Shift+M on the Events page. |
| **Awarding type** | Lot — entire basket of products awarded to a single vendor. Line Item — award can be split across multiple vendors, item by item. |
| **Savings tracking** | Savings calculated on Gross Total or Line Item basis, against Budget, Historical Price, or Existing Proposal reference. |
| **Counter Offer** | Buyer can send a counter offer to a vendor during the live RFQ or at evaluation time — proposing a different price. Note: quantity counter offers are discontinued (see Section 4). |

## 6.3 Auction

An Auction is a live, time-bound bidding event where vendors compete in real time. Procol supports both Reverse Auctions (bids move downward — typical for procurement) and Forward Auctions (bids move upward — where applicable).

Specific auction formats are covered in Sections 12-15. All auctions are published by the Auction Team after a buyer-created draft is reviewed.

# 7. Event Combinations

The eRFX module is flexible — a buyer can design the exact sourcing process that fits the requirement. The supported combinations are:

| # | Combination | When to Use |
| --- | --- | --- |
| **1** | **RFP + RFQ** | Vendors are first evaluated technically via RFP, then shortlisted vendors are invited to submit price quotes in a follow-on RFQ. |
| **2** | **RFP + Auction** | Vendors are evaluated technically via RFP, then shortlisted vendors compete in a live auction for final price discovery. |
| **3** | **RFP only** | Used purely for technical evaluation, with no commercial bidding stage attached. Results in a shortlist for future events. |
| **4** | **RFQ only** | A straightforward quotation event with no technical stage or auction. Suitable when vendors are pre-qualified. |
| **5** | **Auction only** | A direct, live bidding event with no prior technical or quotation stage. Used for well-understood, standardized requirements. |
| **6** | **RFP + RFQ → Auction** | After the technical stage, an RFQ is run, and then converted into a live auction for final price discovery. Full three-stage process. |
| **7** | **RFQ → Auction** | An RFQ is run first; if prices are not satisfactory, it is converted into a live auction for further price discovery, without a technical stage. |

# 8. Lot Splitting

## What is Lot Splitting?

After a sourcing event has received bids from vendors, the buyer can split the event into multiple "lots." Each lot is a sub-group covering specific line items or combinations of line items. Once split, further sourcing actions (CBD, awarding, PO creation) can be taken separately for each lot.

| Material PRs Only |
| --- |
| Lot splitting is available ONLY for events created from Material PRs. Events created from Service PRs do not support lot splitting. Verify the PR type before planning a lot-split sourcing strategy. |

| Simple Example |
| --- |
| An RFQ has 10 line items (Material PR). After bids are received, the buyer splits into 3 lots: Lot A (civil items, lines 1-3), Lot B (electrical items, lines 4-7), Lot C (mechanical items, lines 8-10). Vendor X is awarded Lot A, Vendor Y is awarded Lot B and C — each with a separate PO. |

## When Can Lots be Created?

Lots are created AFTER bids have been received in an event. Lot splitting is not available during event creation — it is a post-bid action.

| Aspect | Details |
| --- | --- |
| **Trigger point** | After the RFQ or Auction stage ends and bids are received and visible |
| **Who can split** | Buyer (with appropriate role permissions) |
| **PR type required** | MATERIAL PRs only — Service PRs cannot be split into lots |
| **What can be split** | Any combination of line items within the event. One line item can belong to only one lot. |
| **Post-split actions** | Each lot proceeds independently to CBD, Master QCS comparison, awarding, and PO generation |
| **Lot Withdrawal** | If a lot needs to be removed or withdrawn, this follows a separate workflow (tested independently from Hold/Unhold) |
| **Phase 1 restriction** | Hold/Unhold of individual line items within split lots is not supported in Phase 1 — the entire event must be held/unheld |

## Lot Splitting Process

| 1 | Event ends, bids received** The RFQ or Auction stage ends and all vendor bids are visible in the event. |
| --- | --- |
| **2** | **Navigate to Lot Splitting** The buyer navigates to the lot management section of the event. |
| **3** | **Create lots** The buyer creates the desired number of lots and assigns line items to each lot. Each line item is assigned to exactly one lot. |
| **4** | **Name and configure each lot** Each lot is given a name/identifier for tracking. Additional lot-specific configuration may be applied. |
| **5** | **Proceed per lot** Each lot now proceeds independently through the Master QCS, awarding, CBD, and PO generation stages. Different vendors can be awarded different lots. |

# 9. Step-by-Step: Creating an RFQ

An RFQ is built on the Events page in Procol (app.procol.in). The full lifecycle has three stages: RFQ Creation → RFQ Live (vendor bidding) → Post-RFQ Evaluation & Awarding.

## Phase 1: RFQ Creation

| 1 | Open the Events page** Log in to app.procol.in and navigate to "Events" in the left sidebar. This shows the Live and History event dashboards. |
| --- | --- |
| **2** | **Create a new event** Press Shift+M to open the new event window. Alternatively, click the "+ New Event" button. Tip: write a clear event title including your company name and event type so vendors are notified clearly. |
| **3** | **Select a template** In the new event window, enter the Event Title, then click "Select Templates." Choose the relevant template for your procurement category (e.g. materials, services, capex). |
| **4** | **Set Event Type to RFQ** In the template/event type selector, set Event Type = RFQ. Also set the Awarding Type: Lot (entire basket to one vendor) or Line Item (split award across vendors). |
| **5** | **Set Delivery Date** Enter the required delivery date for the line items. This is visible to vendors in their bid form. |
| **6** | **Add products and quantities** Add the line items from the PR. Each item has: Product (material code/name), Quantity Requested, and Delivery Location. These are pulled from the PR automatically if sourcing from a PR. |
| **7** | **Add custom columns (optional)** Add Creator-filled columns (filled by buyer, e.g. budget benchmark) or Participant-filled columns (filled by vendors, e.g. GST rate, freight charges, product discount). Mark any column as "required" for vendor completion. |
| **8** | **Configure savings** Set how savings are measured: Gross Total or Line Item basis. Set the reference amount type: Budget, Historical Price, or Existing Proposal. In Line Item mode, savings are calculated per item; in Gross Total mode, savings are across all items together. |
| **9** | **Set Terms & Conditions** Type T&C directly or upload as a file. Mark them mandatory for vendors (all vendors must accept T&C before submitting a bid). |
| **10** | **Add participants** Add vendor participants by searching for them in Procol. For closed tender, only added vendors can see and bid. For open tender, leave open (see Section 11). |
| **11** | **Schedule** Set the RFQ start time, end time, and evaluation duration (time after end for the buyer/evaluator to assess bids). |
| **12** | **Review and Publish** Review all details, then click Publish. Vendors receive email notifications and can log in to trade.procol.in to submit bids. |

## Phase 2: RFQ Live (Vendor Bidding)

| 1 | Vendors receive notification** Invited vendors receive an email with the event details and a link to trade.procol.in. |
| --- | --- |
| **2** | **Vendor submits bid** Vendor logs in, reviews all event details (items, quantities, T&C), fills in prices for each line item, and submits their quotation. |
| **3** | **Track responses** The buyer monitors the Responses tab — seeing which vendors have submitted, viewed but not submitted, or not yet opened the event. |
| **4** | **Counter Offer (optional)** The buyer can send a counter offer to a specific vendor on their submitted bid (different price, not different quantity — quantity changes create new versions). |
| **5** | **Event ends** At the scheduled end time, the event closes. No more bids are accepted. |

## Phase 3: Post-RFQ

| 1 | Review bids** Buyer reviews all submitted bids in the Responses tab. |
| --- | --- |
| **2** | **Master QCS** Navigate to the Master QCS (MQCS) tab for a side-by-side comparison of all vendor bids. See Section 18. |
| **3** | **Award** Select the winning vendor(s) and award the quantities. See Section 18. |
| **4** | **Convert to Auction (optional)** If further price discovery is needed, convert the RFQ to a live Auction. This creates an Auction event with the same items and invited vendors — the Auction Team then publishes it. |

# 10. Step-by-Step: Creating an Auction (Auction Team)

Auction events follow the same initial creation steps as an RFQ, but use "Auction" as the event type. Crucially, the Auction Team (not the regular buyer) publishes the final live event. This section covers the full flow from buyer draft to auction team publish.

## Buyer: Create the Auction Draft

| 1 | Open Events and create new event** On app.procol.in Events page, press Shift+M or click + New Event. |
| --- | --- |
| **2** | **Select template and set Event Type = Auction** Click "Select Templates," choose the relevant template, then set Event Type = Auction (or the specific format: Rank on Line, Dutch, Knockout — see Sections 12-15). |
| **3** | **Set auction format** For Rank on Line (British): this is the default auction format showing live rank updates. For Dutch, Knockout, or Traffic Light: select the specific format and configure format-specific rules. |
| **4** | **Add products, quantities, delivery locations** Same as RFQ — add line items with quantities and delivery locations. |
| **5** | **Set event title and T&C** Give the auction a clear title and add Terms & Conditions. |
| **6** | **Add participants** Invite the vendor participants (or configure as open tender). |
| **7** | **Save as Draft** Save the event as a draft. Do NOT publish — this is the Auction Team's responsibility. |
| **8** | **Notify Auction Team** Inform the Auction Team that the draft is ready for review and publishing. |

## Auction Team: Review and Publish

| 1 | Auction Team logs in** The Auction Team user logs in to app.procol.in with their dedicated credentials. |
| --- | --- |
| **2** | **Review the draft event** Open the draft event created by the buyer. Review all details: items, quantities, format, configuration, participants, T&C. |
| **3** | **Make final adjustments (if needed)** The Auction Team can adjust auction-specific configuration — starting price, price increments, time intervals, ceiling/floor prices, round durations, etc. |
| **4** | **Schedule the auction** Set the Auction Start time, End time, and Evaluation Duration. For Dutch/Knockout, set round intervals and price step sizes. |
| **5** | **Publish the auction** Click Publish. The auction goes live at the scheduled time. All invited vendors receive notifications. The Publish Event dialog shows: event title, start/end time, evaluation time, and vendors invited. |
| **6** | **Monitor the live auction** Track submissions, rank changes, bid activity, and participant status in real-time from the event dashboard. |
| **7** | **Close and evaluate** At the end time, the auction closes. Bids are locked. The Auction Team and buyer move to the Master QCS for evaluation and award. |

| Key Principle: Auction Team Controls Publishing |
| --- |
| The separation between buyer (creates and configures) and Auction Team (reviews and publishes) is deliberate. It ensures all auction events are quality-checked before going live. Regular buyers do not have permission to publish auction events. |

# 11. Open Tender

## What is Open Tender?

By default, Procol events are closed tenders — only specifically invited vendor POCs can see and participate in the event. Open Tender changes this: the event is published openly, and any vendor who is mapped to the relevant category in Procol can participate and place bids.

| Type | Details |
| --- | --- |
| **Closed Tender (default)** | Only vendors specifically added by the buyer to the participant list can see and bid. Best for situations where you have a known, pre-qualified vendor list. |
| **Open Tender** | Any mapped vendor (registered and categorized in Procol) can see the event and participate. Additionally, specific vendors can also be directly invited by name. Best for situations where you want maximum competition or market price discovery. |

## Open Tender Features

- Any vendor mapped to the event's procurement category in Procol can view the event and submit a bid.
- The buyer can also specifically invite named vendors even in an open tender — ensuring known vendors are directly notified.
- Open tenders are visible on a vendor-facing discovery page for mapped categories.
- All compliance and T&C acceptance requirements still apply — vendors must accept T&C before submitting.
- The buyer can see all participating vendors and their bid status in the Responses tab.

| When to Use Open Tender |
| --- |
| Open tender is appropriate when: (a) the buyer wants to discover market pricing without restricting to a pre-selected vendor list; (b) the requirement is for a commodity or standardized item with many potential suppliers; (c) transparency and maximum competition are priorities; or (d) the buyer wants to onboard new vendors through competitive participation. |

# 12. E-Auction Formats — British Reverse Auction (Rank on Line)

## Overview

The British Reverse E-Auction (also called Rank on Line in Procol) is the standard, most commonly used auction format. Vendors see their live rank relative to other bidders (by rank, price, or both) and continuously lower their bids to compete. Bids can only move downward — once submitted, a bid cannot be increased.

| Aspect | Details |
| --- | --- |
| **How it works** | The auction starts and vendors submit their opening bids. As each vendor submits, the rank updates in real time. Vendors see their position and can lower their bid to improve their rank. The lowest bidder at the end of the event wins (for line item awarding, the lowest bidder per item wins that item). |
| **Price direction** | Downward only — vendors can only lower their previously submitted bid. |
| **Visibility** | Vendors see their own rank and the current L1 (lowest) price. They do not see competitor names or exact competitor prices (unless configured otherwise). |
| **Market feedback** | Real-time rank and price updates as bids come in. Creates bid compression as vendors race to the top (bottom) position near the close. |
| **Best for** | Markets with good competition and many suppliers. Works well when supplier specifications are similar and price is the key differentiator. |
| **Bid fatigue risk** | Repeated use of the same format with the same supply base can cause bid fatigue. If the top two initial RFQ bids differ by more than ~10%, consider a different format. |

| Caution |
| --- |
| Suppliers ranked 3rd and below lose confidence and may disengage if the gap to L1 is too large. Monitor participation closely during the live auction and consider extending if participation drops. |

## Rank on Line: Configuration

| Parameter | Details |
| --- | --- |
| **Starting bids** | Vendors enter their opening bid when the auction goes live. |
| **Bid decrement** | No mandatory decrement — vendors can lower by any amount. The buyer can optionally set a minimum bid decrement. |
| **Extension rules** | The event can be extended if bids are submitted near the close time (soft close / sniping protection). |
| **Awarding** | Single vendor (Lot mode) or split across vendors (Line Item mode — the lowest bid on each item wins that item). |

# 13. E-Auction Formats — Dutch Auction

## Overview

Dutch Auction is a new e-auction format in Procol for the eRFX module. The price starts low (favorable to the buyer) and steps up automatically at fixed intervals. Vendors see only the current price and a countdown — no competitor visibility. The first vendor to accept the displayed price wins instantly and the event ends.

## When to Use Dutch Auction

- The buyer does not have clarity on ballpark market prices, so a reference/target price cannot be set confidently.
- A small number of suppliers are involved.
- Winning the contract represents a large share of a supplier's business — the private value of winning is high.
- One supplier is known to have a clear cost advantage, or only one supplier is bidding.

## How Dutch Auction Works

| 1 | Auction starts at a low price** The auction opens at the Starting Price — a price favorable to the buyer (below expected market price). |
| --- | --- |
| **2** | **Price steps up automatically** At each configured time interval, the displayed price increases by the configured Price Increment. |
| **3** | **Vendors see price + countdown** Vendors see only the current price and a countdown to the next price step. No competitor information is shown. |
| **4** | **First vendor to accept wins** When a vendor clicks "Accept Current Price," they win the deal immediately. The event closes for all vendors at that instant. |
| **5** | **No going back** Once a vendor accepts, it is binding — the vendor must honor the accepted price and the buyer must award to that vendor. |
| **6** | **Ceiling reached with no acceptance** If the price reaches the Ceiling Price with no vendor accepting, the event closes unresolved. A new event or different format is needed. |

## Dutch Auction Configuration Fields

| Field | Details |
| --- | --- |
| **Event Title & Template** | Same as any RFQ/Auction — descriptive title, appropriate template. |
| **Event Type** | Auction → Dutch |
| **Starting Price** | The opening price — low and favorable to the buyer. This is where the auction begins. |
| **Ceiling Price** | The maximum price the buyer will accept. If reached without acceptance, the auction closes unresolved. |
| **Price Increment** | The step size by which the price increases at each interval (e.g. increase by ₹500 per step). |
| **Time Interval** | How often the price steps up (e.g. every 30 seconds, every 2 minutes). |
| **Products, Quantities, Delivery** | Same as standard RFQ/Auction — added from the PR. |
| **Participants & T&C** | Vendor participants and Terms & Conditions — same process as RFQ. |
| **Schedule** | Start time. The auction runs until a vendor accepts or the ceiling price/max duration is reached. |

## Dutch Auction: Business Rules

| Rule | Detail |
| --- | --- |
| **Single winner only** | The first vendor to accept wins. There is no second or third place. |
| **Binding acceptance** | The winning vendor must honor the accepted price. The buyer must award the business to that vendor. |
| **No price discovery** | Unlike British or Knockout auctions, bids are not compared against each other. The buyer must set Starting/Ceiling price carefully upfront. |
| **No extension on accept** | Once a vendor accepts, the event cannot be extended — it closes immediately. |
| **No counter-offers** | Counter-offers are not applicable — there is no back-and-forth once an acceptance is made. |
| **Single winner always** | Split/partial awarding is not available in Dutch Auction — it always has one winner. |

| Caution |
| --- |
| Dutch Auction has no price discovery mechanism (unlike British or Japanese reverse auctions). Use it carefully for high-common-value items that are hard to price. The buyer's pricing intelligence is critical for setting a sensible Starting and Ceiling price. |

## Dutch Auction: Post-Auction Flow

Once a vendor accepts, the Dutch Auction rejoins the standard eRFX flow:

| 1 | Winner Declared** The accepting vendor is immediately declared the winner. All other vendors see the event has closed. |
| --- | --- |
| **2** | **Cost Breakdown (CBD)** The winning vendor completes the cost breakdown on trade.procol.in. See Section 19. |
| **3** | **Master QCS** After CBD is submitted, the accepted bid flows into the Master QCS (MQCS) for the buyer to make the final award. |
| **4** | **PO Form & NFA** PO is created, filled, and submitted — triggering the standard NFA approval flow. |
| **5** | **Order ID & SAP PO** Once approved, a system Order ID is generated and the PO is pushed to AMNS SAP. |

# 14. E-Auction Formats — Knockout (Japanese) Auction

## Overview

Knockout Auction (Japanese Reverse E-Auction) is a round-based format where the price starts high and steps down. In each round, a vendor must accept to stay in — or gets knocked out. The last vendor remaining wins at the final accepted price.

## When to Use Knockout Auction

- The price difference between suppliers is large, making it hard to negotiate directly with the L1 (lowest) bidder.
- A limited number of suppliers are involved, and the buyer wants to create bid compression between them.
- Supplier specifications or qualifications differ, making a straight price-rank auction (British) unsuitable.
- Confidentiality of the final price is required — only the winning vendor sees the final price.

## How Knockout Auction Works

| 1 | Auction starts high** The auction opens at the Starting Price — a high price, acceptable to vendors. |
| --- | --- |
| **2** | **Price steps down per round** At each time interval, the price decrements by the configured tick size. Each decrement is a new round. |
| **3** | **Vendors accept or drop each round** In each round, a vendor has until the countdown expires to Accept (stay in the next lower round). A vendor who doesn't accept within the round is knocked out. |
| **4** | **Knocked-out vendors can watch** Knocked-out vendors can still view the auction running live but cannot re-enter or bid. This creates an offline negotiation window — the buyer may negotiate with knocked-out vendors if live rates aren't acceptable. |
| **5** | **Last vendor standing wins** The auction continues to lower and lower prices until only one vendor remains. That vendor wins the deal at the final accepted price. |
| **6** | **Floor price reached** If every vendor is knocked out before the floor price is reached, the event closes unresolved and a new event is needed. |
| **7** | **Buyer intervention (optional)** The buyer can manually push a revised price and expiry at any point instead of letting rounds run automatically. |

## Knockout Auction Configuration Fields

| Field | Details |
| --- | --- |
| **Event Type** | Auction → Knockout |
| **Starting Price** | High initial price — acceptable to all vendors at the start. |
| **Floor Price** | Minimum price the buyer is willing to consider. Auction stops if reached without a winner. |
| **Price Decrement** | Tick size — how much the price drops each round (e.g. drop by ₹1,000 per round). |
| **Time Interval per Round** | How long each round lasts before non-acceptance = knockout (e.g. 3 minutes per round). |
| **Products, Quantities, Participants** | Same as standard RFQ/Auction. |
| **Schedule** | Start time — rounds run automatically on configured tick/time unless buyer manually revises. |

## Knockout Auction: Business Rules

| Rule | Detail |
| --- | --- |
| **Single winner** | The last supplier remaining active wins and ends the event. |
| **No re-entry** | Once knocked out (decline or timeout on a round), a vendor cannot re-join that event. |
| **Forced truthful bidding** | Vendors must accept or drop at each price level in real time — they cannot opt out and watch, then re-enter. |
| **Confidential closing price** | Only the winning vendor sees the final winning price. Knocked-out vendors see only that the auction is still running — not the winning price. |
| **Offline negotiation window** | Knocked-out vendors remain visible to the buyer, who may negotiate with them offline if live rates aren't acceptable. |
| **No counter-offers** | A round is Accept/Decline only — no negotiated middle value inside the auction itself. |
| **No split awarding** | Knockout Auction always has a single winner. |

| Caution |
| --- |
| In a strict "winner takes all" market, the closing price is effectively one decrement below where the second-last supplier dropped out. If valuations vary widely, Dutch or a hybrid format may create more pressure. |

## Knockout Auction: Post-Auction Flow

Once a single supplier remains, Knockout Auction rejoins the standard eRFX flow: Winner Declared → Cost Breakdown (CBD by vendor) → Award in Master QCS → PO Form & NFA → Order ID & SAP PO.

# 15. E-Auction Formats — Traffic Light Auction

## Overview

Traffic Light Auction is used in categories such as Capex, MRO, and services where prices aren't predefined and the buyer doesn't have visibility into supplier margins — but does have a target price in mind. Vendors' bids are shown in color-coded zones (green/yellow/red) rather than exact ranks.

## When to Use Traffic Light Auction

- Buying in complex categories where price benchmarks aren't readily available (Capex, MRO, services).
- Buyer has a target price and wants to signal acceptable ranges without disclosing exact rank.
- Most specifications are quantitative/defined, making a faster price-signal auction suitable.
- Buyer wants to sustain competitive pressure even within the "green zone" (best bids).

## How Traffic Light Auction Works

An RFQ is typically run first to gather a reference (L1) price. The buyer then defines green/yellow/red price zones around that reference for the auction:

| Zone | What it Means |
| --- | --- |
| **Green Zone** | Bids within an acceptable percentage of the target price. These bids are shown in green — vendors know they are competitive. |
| **Yellow Zone** | Bids slightly above the target. Vendors in yellow know they are close but not yet within the target range. |
| **Red Zone** | Bids significantly above the target. Vendors in red know their pricing is not competitive. |

Vendors see their own color zone, not their exact rank or the number of competitors in each zone. They can lower bids to move from red → yellow → green.

| Key Dynamics |
| --- |
| The buyer bakes in an expected price without discouraging vendor participation — vendors don't see exactly where they stand among competitors. Even vendors in the green zone are motivated to improve — they cannot see if others are also in green, so there is still competitive pressure. Vendors in red may feel demotivated to compete. Buyers who set zones too aggressively can create unrealistic expectations. |

# 16. Choosing the Right Auction Format

The choice of auction format significantly impacts the quality of price discovery and vendor participation. Use the table below to select the most appropriate format for the situation.

| Format | Best When... | Advantages | Caution |
| --- | --- | --- | --- |
| **British Reverse** | Good competition, many suppliers, similar specs | Transparency; real-time rank feedback; bid compression near close | Bid fatigue with same vendors; 3rd+ vendors lose confidence; avoid if top 2 bids differ >10% |
| **Dutch Reverse** | Few vendors; one vendor has clear cost advantage; high private value | Maximum pressure via FOMO; fastest auction; first-mover wins | No price discovery; buyer must price carefully upfront; no second chance |
| **Knockout (Japanese)** | Large price gap between vendors; need confidentiality; few suppliers with differing specs | Forces truthful bidding; extra confidentiality; offline negotiation possible | Can run long; closing price = one tick below 2nd-last dropout; less FOMO than Dutch |
| **Traffic Light** | Capex/MRO/services with unclear pricing; buyer has a target; faster auction needed | Signals acceptable price ranges; sustains green-zone competition | Red zone vendors disengage; poorly set zones create unrealistic expectations |

## Format Selection Quick Guide

| Scenario | Recommended Format |
| --- | --- |
| **Many vendors, standard items → British** | Use Rank on Line (Rank on price/rank) for competitive markets with multiple similar vendors. |
| **Few vendors, high-value contract → Dutch** | Use Dutch when one vendor likely has a clear advantage and speed/FOMO is needed. |
| **Few vendors, big price gap → Knockout** | Use Knockout (Japanese) to compress prices confidentially when vendors are priced very differently. |
| **Capex/MRO, unclear pricing → Traffic Light** | Use Traffic Light when you have a target price but complex pricing uncertainty. |
| **Top 2 RFQ bids differ by >10% → Not British** | The British auction will not create meaningful competition. Switch to Dutch or Knockout. |

# 17. Event Tracking — Live & History Tabs

| Feature | Details |
| --- | --- |
| **Live Tab** | Shows all events currently active and open for vendor participation. Displays real-time bid counts, vendor participation status, and remaining time. Any live event can be extended (more time added) or withdrawn (removed from vendor view) as needed. |
| **History Tab** | Shows all past events — whether completed, awarded, cancelled, or withdrawn. Used for record-keeping and audit reference. Reports are NOT part of the Hold/Unhold scope. |
| **Extend** | Any live event can have its end time extended. Vendors receive a notification that the deadline has been extended. |
| **Withdraw** | An event can be withdrawn (pulled back) before it closes. Vendors are notified. A withdrawn event remains in the History tab for reference. |
| **Counter Offer** | On a vendor's submitted response, the buyer can send a counter offer — proposing a revised commercial term — either during the live event window or at evaluation time after it ends. Note: quantity changes are no longer done via counter offer (see Section 4). |
| **Analytics & Price Trends** | Active auction events show real-time analytics: bid count, price trends, rank changes, and participation rates over the event timeline. |

# 18. Awarding — Master QCS (MQCS)

## What is the Master QCS?

The Master QCS (Master Quote Comparison Sheet) is the central evaluation and awarding screen in Procol. After the auction ends and CBD (Cost Breakdown) is submitted by vendors, the buyer navigates to the Master QCS to compare all bids side by side and make the final award decision.

| Aspect | Details |
| --- | --- |
| **Access** | The Master QCS tab is available within each event, after the event ends and CBD submissions are received. |
| **What it shows** | All submitted vendor bids for each line item, displayed side by side. Includes price per item, total values, delivery period, taxes, and other commercial fields depending on the template. |
| **Savings indicator** | Shows savings vs. the configured reference price (budget, historical, or existing proposal) for each vendor's bid. |
| **Awarding options** | Lot awarding: the entire basket of products is awarded to one vendor. Line Item awarding: each line item can be awarded to a different vendor — the buyer selects the winning vendor per item. |
| **Split quantity** | In Line Item mode, the buyer can also split the quantity of a single line item across multiple vendors (e.g. 60% to Vendor A, 40% to Vendor B). |
| **Lot-based MQCS** | After lot splitting (Material PRs only), the MQCS is shown per lot — each lot has its own comparison and award. |

| Awarding Restrictions |
| --- |
| Vendors scored TNA (Technically Not Acceptable) in the RFP stage CANNOT be awarded, regardless of their commercial price.Vendors who submitted Regret on a line item during the RFP stage CANNOT be awarded for that line item.The system enforces these restrictions — TNA and Regretted vendors will not appear as selectable options for awarding in the Master QCS. |

| 1 | Navigate to Master QCS tab** Open the event and click on the "Master QCS" or "MQCS" tab. Ensure CBD submissions are received before proceeding. |
| --- | --- |
| **2** | **Review all vendor bids** Compare bids across all vendors for each line item. TNA and Regretted vendors are not selectable. Look at total cost, unit price, delivery, savings, and commercial terms. |
| **3** | **Select winning vendor(s)** For Lot mode: select the winning vendor for the entire lot. For Line Item mode: select the winning vendor for each line item individually. |
| **4** | **Award the quantities** Confirm the awarded quantities. In split-quantity mode, enter the percentage or absolute quantity for each vendor. |
| **5** | **Initiate the PO** Click "Create PO" or "Initiate Award" to begin the PO generation process for the awarded lines. See Section 20. |

# 19. Cost Breakdown (CBD) After Live Auction

## What is Cost Breakdown (CBD)?

After the live auction ends (and BEFORE the final award decision is made), the vendor(s) who participated are required to complete a Cost Breakdown (CBD). The CBD is a detailed decomposition of the total bid price into its constituent cost components. This gives AM/NS India visibility into how the vendor has priced their offer, supports the award decision, and is required before the buyer can proceed to awarding in the Master QCS.

| When Does CBD Happen? |
| --- |
| **Auction ends → CBD submitted by vendor(s) → Award in Master QCS → PO Creation → Approval → SAP PO** CBD comes AFTER the auction ends and BEFORE the award is made. The buyer cannot finalize awarding in the Master QCS until the relevant vendor(s) have submitted their CBD. |

## How CBD Works

| 1 | Auction ends** The live auction (British / Dutch / Knockout / Traffic Light) ends. Bids are locked. |
| --- | --- |
| **2** | **Vendor(s) receive CBD request** The vendor(s) who participated receive a notification (in trade.procol.in and by email) to complete the cost breakdown for their bid. |
| **3** | **Vendor opens CBD form** The vendor logs in to trade.procol.in and opens the CBD form for the event. |
| **4** | **Cost is pre-split into equal parts** The platform pre-populates the cost breakdown with the total bid amount split equally across the predefined cost components (e.g. material cost, labour cost, overheads, profit margin, taxes — the specific components depend on the category and template configuration). |
| **5** | **Vendor adjusts the ratio** The vendor reviews the pre-split cost breakdown. They can change the ratio for each cost component to accurately reflect their actual cost structure. The total must still add up to their bid price — the system validates this. |
| **6** | **Vendor submits CBD** The vendor clicks Submit to finalize the cost breakdown. At this point, the cost structure is locked. |
| **7** | **Buyer reviews CBD and awards** The buyer can review the submitted CBD(s) in Procol and then proceeds to the Master QCS to make the final award decision. |
| **8** | **Proceed to PO** After awarding is confirmed, the buyer creates the PO form and submits for NFA approval (Section 20). |

| Why CBD Matters |
| --- |
| Cost Breakdown gives AM/NS India a clear view of the cost composition for each procurement, not just the total price. This helps with: informing the award decision, future price benchmarking for the same category, identifying cost reduction opportunities in specific components (e.g. if labour costs seem high), supporting should-cost analysis, and compliance with internal procurement governance requirements. |

# 20. Purchase Order (PO) Generation & NFA Approval

## Overview

Once the award is confirmed and CBD is submitted, the buyer creates and submits the Purchase Order (PO) in Procol. The PO triggers an NFA (Note for Approval) workflow. Upon full approval, Procol generates a system Order ID and pushes the PO to AMNS SAP.

| 1 | Navigate to PO creation** From the awarded event (Master QCS), click "Create PO" or navigate to the PO generation section. |
| --- | --- |
| **2** | **Fill the PO form** The PO form is pre-populated with awarded items, quantities, vendor details, and prices from the event. The buyer fills in remaining mandatory fields: delivery details, payment terms, special instructions, document references. |
| **3** | **Attach documentation** Attach relevant documents: event summary, Master QCS output, CBD breakdown, any approved deviation notes, vendor confirmation. |
| **4** | **Submit PO as NFA** Click "Submit" to trigger the NFA (Note for Approval) for the PO. Every configured approver in the PO approval chain is notified. |
| **5** | **Approvers review** Each approver reviews the PO and either approves or rejects. Rejection returns the PO to draft for correction. |
| **6** | **All approvers approve** Once all approvers in the chain have approved, the PO is confirmed. |
| **7** | **System Order ID generated** Procol generates a unique system-generated Order ID for tracking. This is the Procol-side PO reference. |
| **8** | **PO pushed to SAP** Procol sends the PO data to AMNS SAP via API integration. SAP creates the corresponding PO and returns the SAP PO number to Procol. |
| **9** | **SAP PO number reflected in Procol** The SAP-generated PO number is stored back in Procol and made visible to the buyer and the vendor (on trade.procol.in). |
| **10** | **Vendor receives PO** The winning vendor can view the confirmed PO (including the SAP PO number) on trade.procol.in. The procurement cycle is complete. |

| PO Rejection → Back to Draft |
| --- |
| If any approver rejects the PO in the NFA flow, it returns to draft status. The buyer corrects the issue (pricing, documentation, vendor details, etc.) and re-submits. The NFA workflow restarts from the beginning. Important: Over-quantity ordering is not allowed. A PO cannot be created for more than the PR line item's requested quantity. |

# 21. ERP Integration — PR, PO & Master Data

Procol automates the procurement workflow end-to-end for AM/NS India by integrating tightly with AMNS SAP (S4 Hana). Three integration types connect SAP to Procol. Integration is done in phases, each taking 2-5 weeks.

## Three Types of Integration

| Integration Type | How it Works |
| --- | --- |
| **1. PR Integration (Phase 2)** | PRs raised in AMNS SAP flow into Procol automatically via API. Buyers see the PR on Procol and can create sourcing events directly. If SAP sends PR data with errors, Procol flags them back to SAP for correction. |
| **2. PO Integration (Phase 1)** | Once a Procol sourcing event is awarded and the PO is NFA-approved, Procol pushes the PO data to SAP via API. SAP creates the PO and returns the SAP PO number to Procol. Done first because it is the highest business-value integration. |
| **3. Master Data Sync (Phase 3)** | Changes to Product, Vendor, and Location master data in SAP are synced to Procol, keeping the platform up to date. Supports Create, Update, and (for Vendors) blacklist-status changes. |

## Phase 1: PO Integration (Typically 2-3 Weeks)

API-based with two sets of APIs — one at Procol's end, one at AMNS SAP's end. A set of whitelisted IPs is exchanged on both sides for a secure connection.

| Task | Owner |
| --- | --- |
| **1. Project Team Alignment** | Procol & AMNS SAP Team |
| **2. Master Data One-Time Sync** | Procol & AMNS SAP Team |
| **3. PO API Structure Creation** | Procol & AMNS SAP Team |
| **4. PO Creation API Development** | AMNS SAP ERP Team |
| **5. Development to send PO Data to SAP** | Procol Team |
| **6. Development to send PO Number back to Procol** | AMNS SAP Team |
| **7. Development Testing** | Procol & AMNS SAP Team |
| **8. Quality Configuration** | Procol & AMNS SAP Team |
| **9. User Acceptance Testing** | Procol & AMNS Team |
| **10. Cut Over and Go-Live** | Procol & AMNS Team |

## Phase 2: PR Integration (Typically 2-3 Weeks)

One set of APIs at Procol's end. AMNS SAP pushes PR data to Procol, which processes it and returns a Procol PR code on success, or flags errors for correction.

| Task | Owner |
| --- | --- |
| **1. PR API Attribute Alignment** | Procol & AMNS SAP Team |
| **2. Development to send PR details to Procol** | AMNS SAP ERP Team |
| **3. Procol Configuration to consume PR** | Procol Team |
| **4. Development Testing** | Procol & AMNS Team |
| **5. User Acceptance** | Procol & AMNS Team |
| **6. Cut Over and Go-Live** | Procol & AMNS Team |

## Phase 3: Master Data Sync (Typically 3-5 Weeks)

Nine sets of APIs at Procol's end (Create/Update/Delete for Location, Product, and Vendor — each capped at 10 objects per JSON call). Supports real-time and asynchronous (batch-interval) syncing.

| Task | Owner |
| --- | --- |
| **1. Attribute Alignment for Product, Vendor, Location** | Procol & AMNS SAP Team |
| **2. Development to send Master Data to Procol** | AMNS SAP ERP Team |
| **3. Procol Configuration to consume Master Data** | Procol Team |
| **4. Development Testing** | Procol & AMNS Team |
| **5. Quality Configuration** | Procol & AMNS Team |
| **6. User Acceptance Testing** | Procol & AMNS Team |
| **7. Cut Over and Go-Live** | Procol & AMNS Team |

## Integration Capabilities & Limits

| Capability / Limit | Details |
| --- | --- |
| **Line items per event** | Maximum 50 line items per RFQ or Auction event. |
| **Line items per PR API call** | Maximum 50 line items per API request; larger PRs require multiple requests against the same PR number. |
| **Supported ERPs** | SAP S4 Hana, Oracle, Infor LX, Business Intelligence. Tally ERP is NOT supported. |
| **Authentication** | Basic Auth, CSRF token-based, and OAuth2-based authentication supported. |
| **PR collation** | Multiple PRs can be collated into one RFQ/Auction (e.g. three 2-line PRs → one 6-line event). |
| **PR split** | A PR line item's quantity or line items can be split across multiple RFQs/POs. |
| **PR short-close** | Remaining PR quantity can be short-closed via the Purchase Request Updation API without a new PO. |
| **PR amendment** | Supported via hold → update via API → unhold workflow. Material and Location on a PR line item cannot be modified. |
| **Partial PR save** | On by default — if one line item errors, the rest of the PR's line items are still created. |
| **PO amendment** | Once a PO number is sent to Procol, no further changes are allowed from Procol. Only cancellation status can flow from SAP to Procol. |
| **Over-quantity ordering** | NOT allowed — PO cannot be for more than the PR line item's requested quantity. |
| **Multi-currency bidding** | Supported — one vendor can bid in USD while another bids in INR, within the same event. |
| **Document attachments** | Up to 5 links per line item and 5 at global level. 10 MB max per document. |
| **Master data migration** | Bulk upload available for existing Vendor, Material, and Location data during initial rollout. |

# 22. Standalone Intake Request (NFA)

A Standalone NFA (Note for Approval) allows buyers to raise an approval request for a purchase that is not tied to a standard PR-based sourcing event. It is used when a direct purchase decision has already been reached and formal approval is required — for example, for single-source nominations, emergency purchases, or pre-negotiated contracts.

## How to Create a Standalone NFA

| 1 | Navigate to Intake** Go to the Intake module on the Procol buyer portal (app.procol.in). |
| --- | --- |
| **2** | **Click "Create Request"** Select Create Request from the top-right. Choose "Request a Purchase." |
| **3** | **Select "Standalone NFA"** On the new request screen, choose the Standalone NFA option (as opposed to a PR-linked request). |
| **4** | **Fill Proposal Details** Complete the 9 proposal questions (see below). All mandatory fields must be filled before submission. |
| **5** | **Enter Total Proposal Value** Specify location, department/procurement function, savings %, and basis of saving. |
| **6** | **Upload Attachments** Attach required documents: Final QCS/Approval Note (mandatory), plus other supporting documents. |
| **7** | **Add Vendor Details** For each recommended vendor: enter Recommended Vendor name, Basic Total (INR), Cost to AMNS (INR), Payment Terms, and Originator Remarks. |
| **8** | **Select Approval Workflow** Choose the appropriate approval clause (value-based or category-based). The system selects the approver hierarchy based on this clause. |
| **9** | **Submit for Approval** Click Submit. The NFA goes into the configured approval workflow. All approvers must approve in sequence. |

## Proposal Details — 9 Questions

| Field | Description |
| --- | --- |
| **1. NFA/RFQ/Plant Reference** | Reference number linking this NFA to a prior RFQ, Plant reference, or sourcing event (if applicable). |
| **2. Additional Text** | Free-text field for additional context or justification for the standalone purchase. |
| **3. E-Bidding Reference** | Reference to any e-bidding event (auction/RFQ) that was conducted prior to this NFA. |
| **4. Monthly Consumption** | Expected monthly consumption of the material or service being approved. |
| **5. Vendor Analysis** | Summary of vendors evaluated, including why the recommended vendor was selected. |
| **6. Priority** | Select one: ARC Proposal / Critical / Normal / Time Validity Proposal. |
| **7. Category** | Select one: Capex / Logistics / Material Opex / Sales / Service Opex / PR-SPR. |
| **8. Sub-Category** | Sub-classification within the chosen category (configured per AMNS procurement structure). |
| **9. Location / Plant** | Select the plant/location this purchase is for (Satarda Mines, Sagasani BP, Hazira Port, 4 MTPA Beneficiation Plant, Hazira, Mumbai Corporate, Pune). |

## Total Proposal Value & Attachments

| Total Proposal Value Field | Details |
| --- | --- |
| **Location** | Plant or site the purchase is for (same list as Q9 above). |
| **Department / Procurement Function** | Internal department responsible for this purchase. |
| **Savings %** | Estimated or achieved savings percentage vs. last price / budget. |
| **Basis of Saving** | How the savings figure was calculated (e.g., vs. last PO price, vs. market rate). |

| Required Attachments |
| --- |
| • Final QCS / Approval Note — MANDATORY. The summary comparison sheet showing all evaluated vendors and the award recommendation. • Tender Report — Summary of the tendering process conducted. • E-Bid Report — Export of the e-bidding event results (if an auction/RFQ was held). • Technical Recommendations — Technical team's evaluation and recommendation. • Technical Bid — Vendor's technical submission. • Negotiation Details — Minutes or summary of any negotiations held. • Initial Offer — Vendor's first-submitted commercial offer. • Mail Communications — Relevant email correspondence with vendors. • Other Documents — Any additional supporting documents. |

## Post-Submission Options

After submitting the NFA, the originator can manage it via the Options menu and the Comments tab.

| Action | Description |
| --- | --- |
| **Options → Withdraw** | Withdraw the NFA before final approval. Resets the approval workflow. |
| **Options → Recreate** | Recreate the NFA (if withdrawn) with the same or modified details. |
| **Options → Audit Logs** | View the full action history for this NFA request — who did what, and when. |
| **Comments Tab** | Add comments or questions for approvers. Approvers can also respond here. Thread-based communication attached to the NFA. |

# 23. Standalone Auction & Surrogate Bids

A Standalone Auction (or Standalone Event) is created directly from the Events module — not from a PR in the Intake module. It is used when the buyer wants to run a quick competitive bidding event for a known requirement without going through the full PR → RFP → RFQ chain. The Auction Team then publishes the event live.

## Creating a Standalone Event

| 1 | Go to Events** Navigate to Events on the buyer portal (app.procol.in). |
| --- | --- |
| **2** | **Click + New Event** Select + New Event. Three project types are shown. |
| **3** | **Choose "Single Stage"** Select Single Stage (source through RFP / RFQ / Auction). The other options are eRFX Project (multi-stage project) and BOQ Based RFX Project (bill of quantities). |
| **4** | **Select Event Type** Choose the event type: Auction (Rank Based / Price Based / Traffic Light / Knockout / Dutch) \| RFQ \| RFP. |
| **5** | **Set Award Type** Choose how the award will be made: Entire lot to a single vendor, OR Partially award to multiple vendors. |
| **6** | **Apply Template** Select the appropriate template (e.g., "commercial for stand alone"). Templates pre-fill commercial fields and parameters. |
| **7** | **Add Product & Details** Enter product name/code, delivery location, description, quantity, and UOM for each line item. |
| **8** | **Add Participants** System suggests vendors based on the product. Use "Invite Vendor" to add specific vendors from the master list. |
| **9** | **Set Schedule** Choose Start Now (begins immediately after publish) or Schedule for Later (set a start date/time). Set End Time duration and Evaluation Time duration. |
| **10** | **Publish Event** Click Publish Event. A summary screen appears. Check "Publish as Open Tender" if desired. Confirm to go live. |

## Surrogate Bids — Buyer Enters Bid on Behalf of Vendor

Surrogate bids allow the buyer to enter a bid on behalf of a vendor — useful when a vendor calls in their bid verbally or cannot access the portal during a live event.

| 1 | Go to Participants Tab** In the live event, navigate to the Participants tab. |
| --- | --- |
| **2** | **Click "Add Bid"** Find the vendor row and click the Add Bid button next to their name. |
| **3** | **Fill All Bid Fields** Enter: Rate, GST %, Incoterms, Delivery Time, Payment Terms, and any additional charges. |
| **4** | **Optionally Set Price Cap** Use "Add Price Cap" to set the maximum price the buyer will accept for this vendor's bid (a floor for the auction from the buyer's perspective). |
| **5** | **Submit Surrogate Bid** Click Submit Quote. The bid is registered under the vendor's name. The audit trail records it as a buyer-entered surrogate bid. |

## Converting an RFQ to an Auction

When RFQ quotes are received but prices are not satisfactory, the buyer can convert the existing RFQ directly into an auction — without starting from scratch. RFQ quotes can optionally be used as the starting bids in the auction.

| 1 | Open the RFQ Event** Navigate to the RFQ event in the Events module. |
| --- | --- |
| **2** | **Open Settings (Gear Icon)** Click the Settings (⚙) gear icon for the RFQ stage. |
| **3** | **Click "Convert to Auction"** Select Convert to Auction from the settings dropdown. |
| **4** | **Choose Conversion Options** Two options appear: (a) Use RFQ quotes as initial bids in the auction — vendors start from their submitted RFQ price. (b) Allow TNA vendors to bid — override the TNA restriction and allow those vendors into the auction. |
| **5** | **Click Continue** Proceed to the auction creation form. Line items are locked from the RFQ and cannot be changed. |
| **6** | **Configure Auction** Set auction format, schedule, and parameters as in a normal auction creation. |
| **7** | **Send to Auction Team** Click "Send to Auction Team." The Auction Team receives the draft, reviews, and publishes the live auction. |

# 24. Counter Offer Module

The Counter Offer module allows the buyer to propose revised commercial terms to a specific vendor — a price, quantity offered, delivery time, or incoterm adjustment — directly from the vendor's response in Procol. The vendor receives a notification and can Accept, Modify, or Decline the counter offer.

## When to Use Counter Offers

| Timing | Details |
| --- | --- |
| **During RFQ Submission Time** | A counter offer can be sent while the RFQ is still open for vendor submissions. |
| **During Evaluation Time** | A counter offer can also be sent after the submission deadline, during the evaluation/comparison phase. |
| **Not for Quantity Changes** | Counter offers are for commercial term negotiation only. Quantity changes create a new event version (not a counter offer). |

## How to Send a Counter Offer (Buyer Steps)

| 1 | Open the Event Responses Tab** Navigate to the RFQ or Auction event and click the Responses tab. |
| --- | --- |
| **2** | **Find the Vendor Column** Locate the target vendor's column. The L1 bid on a line item is highlighted in green. A "C" indicator appears on any line item where a counter offer already exists for another vendor. |
| **3** | **Click "Counter Offer"** Click the Counter Offer button at the top of the vendor's column. |
| **4** | **Fill Counter Offer Fields** Complete the counter offer form (see fields below). Last PO Price is shown for reference. |
| **5** | **Submit Counter Offer** Click Submit. The vendor receives an email/portal notification. |

## Counter Offer Fields

| Field | Description |
| --- | --- |
| **Quantity Offered** | The quantity the buyer is willing to award at the counter terms (may differ from original quote quantity). |
| **Rate** | Proposed revised unit price. |
| **Delivery Time** | Proposed delivery lead time (in days or weeks). |
| **Incoterms** | Dropdown — standard incoterms (EXW, FOB, CIF, CFR, DDP, etc.). |
| **Additional Charges** | Any surcharges or handling fees. |
| **FOB / CIF / CFR Charges** | Freight and related charges if applicable under the selected incoterm. |
| **Packaging & Forwarding** | Packaging and forwarding cost component. |
| **Counter Offer Remarks** | Free-text field for the buyer to explain the counter offer rationale to the vendor. |

## Vendor Response to Counter Offer

The vendor logs in to trade.procol.in and sees the counter offer notification on the relevant event. They have three choices:

| Vendor Action | What Happens |
| --- | --- |
| **Accept Offer** | Vendor accepts the counter offer terms as-is. The counter offer becomes the vendor's final bid. |
| **Modify** | Vendor edits one or more fields and clicks "Place Modified Bid." A Remarks field is required (vendor explains modification). The modified counter offer is sent back to the buyer. |
| **Decline** | Vendor declines the counter offer entirely. Their original submitted bid stands. |

## Counter Offer Status Indicators (Buyer View)

| Status Label | Meaning |
| --- | --- |
| **Counter Offer Requested** | Buyer has sent the counter offer; vendor has not yet responded. |
| **Counter Offer Accepted Bid** | Vendor accepted the counter offer terms. |
| **Modified Counter Offer Bid** | Vendor modified the counter offer and sent back revised terms. |
| **Last Counter Offer Rejected** | Vendor declined the counter offer; original bid stands. |

## Bulk Counter Offer — Send to All Vendors Simultaneously

Bulk Counter Offer sends the same counter offer to all participating vendors at once — useful when the buyer wants to push a market-wide price target.

| 1 | Open Event Settings** Click the Settings (⚙) gear icon on the RFQ/Auction stage. |
| --- | --- |
| **2** | **Click "Send Bulk Counter Offer"** Select Send Bulk Counter Offer from the dropdown. |
| **3** | **Set Bulk Counter Terms** The bulk counter offer panel shows: Submission-End Rank, Loading Factor, Incoterms, LD Clause, Total Evaluated Price, Less GST, Cost to AMNS, Cost to AMNS With Loading, Overall Total. |
| **4** | **Send** Click Send. All participating vendors receive the counter offer simultaneously. Each vendor's individual Accept / Modify / Decline workflow then applies. |

# 25. Event Management Actions

The Settings (⚙) gear icon on each event stage provides a set of management actions. Available actions differ depending on whether the stage is Technical (RFP) or Commercial (RFQ/Auction). The three-dot (⋮) menu provides project-level actions.

## Settings Menu — Technical Stage (RFP)

| Action | Description |
| --- | --- |
| **Shared With** | View or modify which internal users (team members, evaluators) can access this event stage. |
| **Extend Submission Time** | Give vendors more time to submit their technical responses (see below for options). |
| **End Submission Time** | Close the submission window early. A Reason must be provided before confirming. |
| **Withdraw** | Withdraw the technical stage. Vendors are notified; submissions are locked. |
| **Order Activity** | View the full activity log for this stage — all actions taken, by whom, and when. |
| **Edit Evaluation Time** | Adjust the evaluation window (the period after submission closes, during which evaluators score responses). |
| **Request for Re-evaluation** | Ask evaluators to re-evaluate responses that have already been scored. |

## Settings Menu — RFQ / Commercial Stage

| Action | Description |
| --- | --- |
| **Recreate Order** | Recreate the RFQ (resets and starts fresh while keeping the same PR linkage). |
| **Shared With** | View or modify which internal users can access this commercial stage. |
| **Extend Submission Time** | Give vendors more time to submit RFQ quotes. |
| **End Submission Time** | Close the RFQ submission window early. Requires a Reason. |
| **Withdraw** | Withdraw the RFQ stage. Vendors notified; all submitted bids locked. |
| **Convert to Auction** | Convert this RFQ into an auction event (see Section 23). |
| **Rejected Bids** | View bids that were rejected (e.g., non-compliant submissions). |
| **Order Activity** | Full activity log for the RFQ stage. |
| **Edit Evaluation Time** | Adjust the evaluation window. |
| **Send Bulk Counter Offer** | Send the same counter offer to all vendors at once (see Section 24). |
| **Show Bidding Currencies** | Display the currencies in which each vendor submitted their bid (supports multi-currency events). |

## Extending Submission Time

Buyers can grant additional submission time to vendors using the Extend Submission Time option. On selecting it, a dialog offers the following extension options:

| Option | Effect |
| --- | --- |
| **15 minutes** | Adds 15 minutes to the current submission deadline. |
| **30 minutes** | Adds 30 minutes. |
| **1 hour** | Adds one hour. |
| **Custom** | Buyer enters a specific number of minutes/hours. |
| **Fixed Time** | Buyer sets a new absolute deadline date and time. |

After selecting the option, click OK. All vendors on the event receive a notification that the deadline has been extended.

## Three-Dot (⋮) Menu — Project-Level Actions

| Action | Description |
| --- | --- |
| **Send Reminders** | Opens the Send Reminders panel (see below). |
| **Change Owner** | Transfer event ownership to another buyer/team member. |
| **Withdraw Project** | Withdraw the entire sourcing project (all stages). Irreversible — vendors are notified. |

## Send Reminders

The Send Reminders panel shows two categories of pending actions and lets the buyer send targeted reminder notifications:

| Category | Details |
| --- | --- |
| **Pending Evaluations** | Lists each assigned evaluator who has not yet submitted their RFP scores. Buyer selects evaluators and sends a reminder. |
| **Offer Submissions** | Lists vendors who have not yet submitted their bid for each active stage (shows stage name next to each vendor). Buyer selects vendors and sends a reminder. |

Select the individuals to remind, then click Send Reminder. Each selected person receives an email/portal notification.

# 26. Vendor Guide — Vendor-Side Experience

This section describes the Procol vendor portal experience from the vendor's perspective. Vendors access the platform at trade.procol.in and participate in Technical (RFP), RFQ, and Auction stages as configured by the buyer.

## Vendor Login

| 1 | Go to Vendor Portal** Open trade.procol.in in a browser. |
| --- | --- |
| **2** | **Enter Phone Number** Enter the registered mobile number for the vendor account. |
| **3** | **Send OTP** Click Send OTP. A one-time password is sent via SMS to the registered number. |
| **4** | **Enter OTP & Login** Enter the OTP and click Login. The vendor dashboard opens. |

## Vendor Dashboard

| Section | Description |
| --- | --- |
| **Active Tab** | Shows all currently live events the vendor is invited to or has been registered for. |
| **History Tab** | Past events the vendor participated in (completed, withdrawn, or awarded). |
| **All Events Tab** | Complete list of all events (active + historical). |
| **Event Card Info** | Each event card shows: Buyer name (AMNS), RFX number, number of items, stage status, and bid submission status. |

## Submitting a Technical Response (RFP Stage)

| 1 | Open the Event** Click the event card on the Active tab. |
| --- | --- |
| **2** | **Go to Technical Stage Tab** Select the Technical Stage tab within the event. |
| **3** | **Open Submission Sheet** Click Submission Sheet to open the per-line-item response form. |
| **4** | **Fill Each Line Item** For each line item, use the quick-fill dropdown to select: "Same as Requested" (vendor can supply as per spec) or "Regret Item" (vendor cannot supply this item). Add optional Remarks for each line item. |
| **5** | **Submit** Click Submit to send the technical response. The evaluator is notified. |

## Submitting an RFQ Quote

| 1 | Go to RFQ Tab** Within the event, click the RFQ tab. |
| --- | --- |
| **2** | **Select Currency** Choose the currency for the quote (INR or foreign currency if enabled). |
| **3** | **Fill Commercial Fields** For each line item, enter: Rate (unit price), Quantity Available, Delivery Time. Optionally fill: Additional Charges, Discount, Packaging & Forwarding, Payment Terms, LD Clause, Warranty Terms, ABG (Advance Bank Guarantee), PBG (Performance Bank Guarantee), Incoterms, Destination, and upload Participant Attachment. |
| **4** | **Review Totals** Basic Total, Additional Charges, and Grand Total are calculated automatically. |
| **5** | **Submit or Revise** Click Submit Quote to finalize. If the submission window is still open, the vendor can use Revise Quote to update their bid. Each revision is logged. |

## Participating in a Live Auction

| 1 | Go to Auction Tab** Within the event, click the Auction tab. The current live rank is shown in the top-right (e.g., "Rank: 1" or "Rank: 3"). |
| --- | --- |
| **2** | **View Current Bids** The current price for each line item is shown. The vendor's rank vs. other vendors is displayed (rank-based auction) or colour-coded (traffic light auction). |
| **3** | **Click Rate to Edit** Click the Rate cell for a line item to open the bid entry field. |
| **4** | **Fill Bid Fields** Enter the revised rate. Fill any required fields (incoterms, delivery time, etc.). |
| **5** | **Click Revise Bid** Click Revise Bid to submit the updated price. |
| **6** | **Enter Remarks** A Remarks field appears — enter a brief note (optional in most setups). Confirm. |
| **7** | **Rank Updates in Real Time** After submission, the rank indicator updates instantly. Vendors can continue revising until the auction timer reaches zero. |

## Messaging — Vendor to Buyer Communication

| 1 | Click Messages Button** In the event view, click the Messages button. |
| --- | --- |
| **2** | **Click New Message** Click New Message to start a new thread. |
| **3** | **Select Message Type** Choose from: Technical Offer on Line Item / Commercial Offer on Line Item / Other General Query. |
| **4** | **Select Line Item** If the message relates to a specific line item, select it from the dropdown. |
| **5** | **Write & Attach** Enter the message text and optionally attach files (spec sheets, clarification docs, etc.). |
| **6** | **Send** Click Send Message. The buyer receives a notification and can reply in the same thread. |

| Alternate Bids |
| --- |
| When the buyer enables Alternate Bids for an event, vendors see an "Offer Alternate Makes" option. The vendor can add a second bid entry with a different make, model, or specification — effectively submitting two competing options within the same event. The buyer sees both bids in the responses tab and can compare across all vendors' main bids and alternate bids simultaneously. |

# 27. Quick Reference Summary

## End-to-End Process Flow

| 1 | AMNS SAP raises PR** Purchase Requisition (Material or Service) created in SAP, automatically pushed to Procol via API. PR carries item, quantity, plant, and reference price. |
| --- | --- |
| **2** | **PR appears in Procol Intake** Buyer sees PR on Procol dashboard. Buyer selects PR(s) to create a sourcing event against. |
| **3** | **RFP — Technical Evaluation** Vendors fill technical answers for each line item and may submit Regret. Evaluator scores each response: T1, T2, T3, or TNA. TNA and Regretted vendors are excluded from commercial bidding. |
| **4** | **Create RFQ / Auction** Buyer creates RFQ for commercial quotes. For Auction: buyer creates draft; Auction Team reviews and publishes live auction. Hold/Unhold applies throughout. |
| **5** | **Auction Team publishes Auction** For auction events: Auction Team reviews draft, configures auction format (British/Dutch/Knockout/Traffic Light), and publishes. |
| **6** | **Open Tender option** For maximum competition, event can be published as Open Tender — any mapped vendor can participate. |
| **7** | **Vendor bidding** Vendors log in to trade.procol.in to submit RFQ bids or live auction bids. |
| **8** | **Auction ends** The live auction closes. All bids are locked. |
| **9** | **Cost Breakdown (CBD)** After auction ends, vendor(s) decompose their bid price into cost components (material, labour, overhead, etc.) and submit CBD on trade.procol.in. CBD is BEFORE awarding. |
| **10** | **Lot splitting (if needed, Material PRs only)** For Material PRs: buyer can split event into lots after bids are received. Each lot proceeds to MQCS and awarding independently. |
| **11** | **Award — Master QCS (MQCS)** Buyer compares all bids in Master QCS and awards to winning vendor(s). TNA and Regretted vendors cannot be selected. |
| **12** | **PO created and approved** Buyer creates PO form, submits as NFA. All approvers approve. System Order ID generated. |
| **13** | **PO pushed to SAP** Procol sends PO data to AMNS SAP via API. SAP PO created and PO number returned to Procol. Cycle complete. |

## Auction Format Decision Tree

| Scenario | Recommended Format |
| --- | --- |
| **Many vendors, similar specs → British** | Use Rank on Line (British Reverse). Best for competitive markets. |
| **Few vendors, one clearly cheapest → Dutch** | Use Dutch for maximum FOMO pressure. Fastest resolution. |
| **Few vendors, large price gap → Knockout** | Use Knockout (Japanese) to compress prices confidentially. |
| **Capex/MRO, target price known → Traffic Light** | Use Traffic Light to signal acceptable price zones. |
| **RFQ prices not satisfactory → Convert to Auction** | Convert the RFQ to an auction (Auction Team publishes). |

## Hold/Unhold Quick Rules

| Rule | Detail |
| --- | --- |
| **CAN hold when...** | NFA is in progress. Event is live with pending submissions. |
| **CANNOT hold when...** | NFA is Approved (PO Failed or PO Success status). |
| **Auto-revoked on hold:** | Submission timers, Counter Offers, NFAs, Best Offer Time. |
| **To unhold, must...** | Repush ALL line items first. Then unhold. Evaluation resumes automatically. |
| **Quantity change → ** | New event version is created (not a counter offer). |
| **5 validated fields:** | Quantity, Budget, shortText, specificationText, itemText. |

## Key Terms Quick Reference

| Term | Meaning |
| --- | --- |
| **app.procol.in** | Buyer/admin portal for AM/NS India |
| **trade.procol.in** | Vendor portal for submitting bids |
| **PR** | Purchase Requisition — from AMNS SAP, the starting point for every sourcing event |
| **NFA** | Note for Approval — approval workflow for both PR creation and PO generation |
| **RFP** | Technical evaluation stage (Request for Proposal) |
| **RFQ** | Commercial quotation stage (Request for Quotation) |
| **Auction** | Live competitive bidding (British / Dutch / Knockout / Traffic Light) |
| **British / Rank on Line** | Standard reverse auction — price goes down, vendors see live rank |
| **Dutch Auction** | Price starts low and steps up — first vendor to accept wins instantly |
| **Knockout Auction** | Price starts high and steps down — vendors who don't accept are eliminated |
| **Traffic Light** | Bids shown as green/yellow/red zones — no exact rank visible |
| **Auction Team** | Dedicated users who review buyer-created auction drafts and publish them live |
| **Open Tender** | Event visible to any mapped vendor (not just invited ones) |
| **Lot** | Sub-group of line items created after bids received; each lot is awarded independently |
| **Master QCS (MQCS)** | Quote Comparison Sheet — side-by-side bid comparison used for awarding |
| **CBD (Cost Breakdown)** | After auction ends (BEFORE awarding), vendor decomposes total bid into cost components. Required before buyer can finalize award. |
| **Hold** | Pause event due to internal changes; all active processes auto-revoked; vendors notified |
| **Unhold** | Resume event after changes; requires all line items repushed; evaluation resumes |
| **Versioning** | Quantity changes create new event/bid versions (not counter offers) |
| **Shift+M** | Keyboard shortcut to create a new event on the Events page |
| **Counter Offer** | Buyer proposes revised commercial terms to a vendor (not quantity changes) |
| **PR Integration** | SAP → Procol: PRs auto-pushed from SAP to Procol via API (Phase 2) |
| **PO Integration** | Procol → SAP: Approved POs auto-pushed from Procol to SAP (Phase 1) |
| **Master Data Sync** | SAP → Procol: Product, Vendor, Location master data kept in sync (Phase 3) |

*— End of Document —*

*For platform access issues, contact the Procol system administrator. Buyer portal: app.procol.in | Vendor portal: trade.procol.in*
