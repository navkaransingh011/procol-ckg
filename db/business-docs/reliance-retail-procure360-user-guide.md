# Reliance Retail Procure360 complete user guide

Status: current · Last reviewed: 2026-09 · Audience: Reliance Retail procurement team and vendors; Procol CS · Source file: reliance_doc_AD.docx · Ingested: 2026-09-12

*This document is an internal reference guide for Reliance Retail team members and vendors covering all aspects of the Procol procurement platform — from creating sourcing events to submitting vendor quotes. Every concept is explained in plain language with step-by-step instructions.*

| Prepared for | Reliance Retail Limited — Procurement Team |
| --- | --- |
| **Platform** | Procol / Procure360 |
| **Portal URL** | ietsrm.ril.com |
| **Classification** | Internal — Confidential |
| **Version** | 1.0 |
| **Date** | 26 August 2026 |

# Table of Contents

This document is organized into the following sections:

1. Introduction to Procol / Procure360

2. Key Concepts & Terminology

3. How to Access Procol — SRM Portal Navigation

4. Sourcing Approaches: eRFX vs. Sourcing Request

5. Buyer Guide: Creating an eRFX Project

6. Buyer Guide: Creating a Sourcing Request (with BAFO)

7. Managing the Technical Stage (Evaluator Guide)

8. Managing the RFQ (Commercial) Stage

9. Unlocking Bids After Evaluation (OTP Process)

10. Awarding the Event & Creating a Purchase Order

11. Vendor Guide: How to Submit a Quote via SRM Portal

12. Template Types Explained

13. Incoterms Reference

14. Reliance Retail: Field Values Quick Reference

15. Frequently Asked Questions

# 1. Introduction to Procol / Procure360

## What is Procol?

Procol (also referred to as Procure360) is a digital procurement platform used by Reliance Retail Limited to manage the sourcing and procurement of goods and services. It replaces manual, email-based procurement with a structured, auditable, and competitive digital process.

At its core, Procol allows the Procurement (Buyer) team to:

- Create structured sourcing events (called RFX or RFQ events) for any material or service — from HVAC and lift maintenance to cold room repairs and MHE services
- Invite vendors to participate and submit their competitive bids online
- Assess vendors technically before collecting commercial (price) bids
- Compare quotes side-by-side using the Master QCS (Quote Comparison Sheet) and award business to the best vendor
- Create and route Purchase Orders digitally with a built-in approval workflow

Vendors invited to participate can:

- Log in securely via the SRM Portal (ietsrm.ril.com) to view event details
- Navigate to Procol through: Additional Services → Sourcing and Procurement → Service RFQ/RFX
- Respond to technical questionnaires (Technical Stage)
- Submit their price bids (RFQ Stage) with item-wise pricing and commercial information

## How Reliance Retail Uses Procol

Reliance Retail runs its procurement through Procol using two distinct workflows depending on the complexity and volume of items:

| Approach | When to Use |
| --- | --- |
| **eRFX Project** | Best for sourcing where each item is individually specified. Items are searched and added one by one from the Procol catalog using service codes or descriptions. |
| **Sourcing Request** | Best for bulk sourcing where many items need to be uploaded at once. Items are filled into a downloadable Excel template and uploaded in bulk. Supports an additional BAFO (Best and Final Offer) round after the initial RFQ. |

| Simple Definition |
| --- |
| Think of Procol as an online tender portal. Just as government tenders invite vendors to submit bids for a project, Procol invites Reliance Retail's approved vendors to bid for procurement requirements — but in a fast, structured, and completely digital format with a full audit trail. |

# 2. Key Concepts & Terminology

Before using Procol, it is important to understand the key terms used throughout the platform. This glossary explains every concept you will encounter.

## Core Platform Terms

| Term | Explanation |
| --- | --- |
| **RFX / RFQ** | Request for Quotation (or Request for X). This is the commercial bidding event where vendors submit their price quotes. "RFX" is the broader term used in Procol for any sourcing event. |
| **eRFX Project** | A sourcing event created by adding line items one by one through a search interface. Best for specific, well-defined requirements. |
| **Sourcing Request** | A sourcing event created by uploading a filled Excel template. Best for bulk requirements with many line items. Also supports the BAFO stage. |
| **Event** | The umbrella term in Procol for any active procurement activity — whether an eRFX Project or Sourcing Request. |
| **Line Item** | An individual material or service being sourced. Each line item has a service code, description, quantity, and unit of measure. |
| **Service Code** | A unique identifier assigned to each material or service in the Procol catalog. Buyers search by service code or description to add items to an event. |
| **Master QCS** | Quote Comparison Sheet — a summary tab showing all vendor prices side by side after the RFQ/BAFO stage ends. Used by buyers to compare quotes and decide the award. |

## Stages in a Sourcing Event

Every sourcing event in Procol can have one or more stages. Reliance Retail typically uses two stages in sequence:

| Stage | What Happens |
| --- | --- |
| **Technical Stage** | The first stage where vendors answer a 12-question questionnaire about their capabilities, certifications, infrastructure, and qualifications. Evaluators review and assign a preference (Approved or Rejected) to each vendor. Only approved vendors proceed to the commercial bidding stage. |
| **RFQ Stage (Commercial Stage)** | The second stage where qualified vendors submit their price bids. Vendors enter item-wise prices, commercial terms (Incoterms, warranty, delivery period), and other commercial information. |
| **BAFO Stage** | Best and Final Offer — an optional additional round available in Sourcing Request events. After reviewing initial RFQ bids, the buyer can convert to BAFO to ask shortlisted vendors for their absolute best price. Only available in Sourcing Request (not in eRFX Project). |

## People & Roles

| Role / Person | Description |
| --- | --- |
| **Buyer** | The Reliance Retail team member responsible for creating and managing the sourcing event in Procol. |
| **Vendor / Supplier** | The company or individual invited to participate in the event and submit a quote. |
| **POC (Point of Contact)** | The specific person at a vendor company who is invited to participate. Each vendor can have multiple POCs registered in Procol. |
| **Evaluator** | The person responsible for reviewing vendor responses during the Technical Stage and assigning an evaluation preference (Approved or Rejected). |
| **Purchase Group** | An organizational grouping in Procol that determines which team/category manages a particular procurement. For Reliance Retail: PG3 \| Reg. PO W/O HR/IR (PG3). |
| **Purchase Organization** | The legal/organizational entity placing the purchase order. Reliance Retail uses: RP01 \| RR Lotus Purc... and RP00 \| Reliance Purch Org. |

## Technical Terms

| Term | Explanation |
| --- | --- |
| **Server ID** | A unique identifier that represents the procurement entity (plant, store cluster, or business unit of Reliance Retail) within Procol. Reliance Retail Server IDs: 455, 454, 419, 433, 444, 451, 452. Selecting the wrong Server ID routes the event to the wrong entity. |
| **Template** | A pre-configured form structure in Procol that defines what information vendors need to fill in during the RFQ stage. Templates include: MRO Services SPOT, ARC, Transportation B2B, OD Transportation B2B, and others. |
| **Assessment / Technical Assessment** | A 12-question set assigned to vendors during the Technical Stage covering equipment, scope, certifications, warranty, safety, OEM, emergency support, and quality. |
| **Incoterms** | Standardized trade terms defining where delivery responsibility transfers from vendor to Reliance Retail. Reliance-specific Incoterms include: AN3, DEQ, DEX, EJW, EXP, EXW. See Section 13 for full reference. |
| **T&C** | Terms & Conditions — contractual terms vendors must agree to when participating in the event. |
| **SOW** | Scope of Work — a document describing exactly what work or materials the vendor must deliver. |
| **DOR** | Definition of Requirements — detailed technical specification used alongside the SOW. |
| **Offer Reference Number** | A unique reference number the vendor assigns to their own quote from their internal records. Used for tracking during negotiation. |
| **OTP** | One-Time Password — used to unlock and view individual vendor bids after the evaluation stage ends. The buyer receives an OTP on their registered mobile number to decrypt sealed bids. |
| **Participation Summary** | A dashboard within the event showing: Invited / Seen / Bid Placed / Bid Not Placed vendor counts. The buyer can send reminders to vendors who have not yet submitted. |

# 3. How to Access Procol — SRM Portal Navigation

Vendors access the Procol platform through Reliance Retail's SRM (Supplier Relationship Management) portal. This section explains how to navigate to Procol from within the SRM portal.

## Portal Details

| SRM Portal URL | ietsrm.ril.com |
| --- | --- |
| **Access Method** | Login with your SRM vendor credentials |
| **Navigation Path** | Additional Services → Sourcing and Procurement → Service RFQ/RFX |
| **Who Can Access** | Vendors who have been registered and invited by Reliance Retail as POCs on specific events |

## Step-by-Step: Accessing Procol via SRM Portal

| 1 | Open the SRM Portal** Open your web browser and navigate to: ietsrm.ril.com |
| --- | --- |
| **2** | **Log In** Enter your registered SRM vendor credentials (username and password). If you have not received your credentials, contact your Reliance Retail buyer. |
| **3** | **Navigate to Additional Services** After logging in, look for the "Additional Services" section in the portal menu or dashboard. |
| **4** | **Select Sourcing and Procurement** Within Additional Services, click on "Sourcing and Procurement." |
| **5** | **Select Service RFQ/RFX** Click on "Service RFQ/RFX." This opens the Procol/Procure360 platform within the SRM portal. |
| **6** | **View Your Events** You will now see all the sourcing events (RFX/RFQ events) where you have been invited to participate. Events with status "Live" are open for your response. |

| Important Access Note |
| --- |
| Vendors access Procol exclusively through the SRM portal at ietsrm.ril.com. Do not attempt to access Procol directly — your account is linked to the SRM portal. If you cannot log in or cannot see events you were invited to, contact your Reliance Retail buyer immediately as the event deadline may be time-sensitive. |

4. Sourcing Approaches: eRFX vs. Sourcing Request

Procol provides two distinct ways to create a sourcing event. Choosing the right approach saves time and reduces errors. Here is a detailed comparison:

| Criteria | eRFX Project | Sourcing Request |
| --- | --- | --- |
| **Item Entry Method** | Search and add items one by one using service code or description | Download Excel template → Fill all items → Upload the sheet |
| **Best For** | Specific, well-defined items where individual attention is needed | Large number of items or recurring bulk requirements (20+ items) |
| **BAFO Support** | Not available — eRFX does not support BAFO stage | Available — can convert to BAFO after initial RFQ stage |
| **Excel Template** | Not required — items added via search | Required — must download, fill, and upload the correct Excel sheet |
| **Process Start** | Events → New Event → eRFX Project | Events → New Event → Sourcing Request |
| **Templates Available** | MRO Services SPOT, ARC, Transportation B2B, OD Transportation B2B | MRO Services Sourcing Request, E2E Transportation |
| **BAFO Template** | Not applicable | MRO Services SPOT BAFO |
| **Rest of Process** | Identical to Sourcing Request after item entry | Identical to eRFX Project after Excel upload (except BAFO option) |

| Key Insight |
| --- |
| Once items are added (either via search or Excel upload), both approaches follow the same process: select stages → choose template → fill buyer/event information → add participants → schedule → publish. The key difference is HOW you add line items at the start, and that Sourcing Request (not eRFX) supports an optional BAFO round for final price negotiation. |

# 5. Buyer Guide: Creating an eRFX Project

The eRFX Project approach is used when you want to add items one by one using their service codes or descriptions. This section walks you through every step from start to finish — including publishing, monitoring responses, ending the event, and unlocking bids.

## Step-by-Step: Creating & Running an eRFX Project

| 1 | Navigate to Events** Log in to Procol and click on "Events" in the left navigation menu. |
| --- | --- |
| **2** | **Create a New Event** Click "New Event" (top right button). A popup appears asking you to choose the event type. |
| **3** | **Select eRFX Project** Choose "eRFX Project." This selects the item-by-item creation approach. |
| **4** | **Select the Server ID** Choose the correct Server ID from the dropdown for the Reliance Retail entity/plant running this procurement. Available Server IDs: 455, 454, 419, 433, 444, 451, 452. Selecting the wrong server routes the event to the wrong team. |
| **5** | **Search and Add Line Items** On the Line Items screen, search for each material or service using the Service Code or description keywords. Click "Add" to include each item. Enter the required quantity and unit of measure (UOM) for each line item. |
| **6** | **Review Line Items** Verify all line items are correctly added with accurate quantities. Remove any incorrect items before proceeding. |
| **7** | **Select Event Stages** Choose which stages your event will have: Technical Stage only, RFQ Stage only, or Technical Stage + RFQ (most common for services). For items requiring vendor qualification, always include the Technical Stage first. |
| **8** | **Select RFQ Template** Choose the appropriate RFQ template: MRO Services SPOT (for one-time services/items), ARC (for annual rate contracts), Transportation B2B, or OD Transportation B2B. The template determines what commercial fields vendors will complete. |
| **9** | **Fill Buyer Information** Enter Reliance Retail buyer details: buyer name and contact, department/plant, Purchase Group (PG3 \| Reg. PO W/O HR/IR), and Purchase Organization (RP01 \| RR Lotus Purc... or RP00 \| Reliance Purch Org). |
| **10** | **Fill Event Information** Enter event details: Event Title (clear and descriptive), Event Description, Category L1 (LIFT, HVAC, MHE, DG, CNF, COLD ROOM, AWNING, or IFMS), Scope of Work (SOW), Terms & Conditions, and any relevant attachments (DOR, drawings, specifications). |
| **11** | **Configure Technical Stage** If Technical Stage is selected: assign the Technical Assessment questionnaire (12-question standard questionnaire), add Evaluators who will score vendor responses, and set the Technical Stage timeline. |
| **12** | **Add Participants (Invite Vendors)** Search for and invite vendor POCs. Only invited POCs can see and respond to this event. Add multiple POCs from the same or different vendors as needed. |
| **13** | **Set Schedule** Set the timeline: Technical Stage start/end date-time (if applicable), and RFQ Stage start/end date-time. Allow adequate time for vendor responses — typically 5-10 business days for complex services. |
| **14** | **Review and Publish** Do a final review of all information. Click "Publish" to make the event live. Invited vendors receive email notifications. The event is now visible to all invited POCs. |
| **15** | **Monitor Participation** Track responses in real-time via the Participation Summary: Invited / Seen / Bid Placed / Bid Not Placed. Use the "Notify" button to send reminders to vendors who have not yet submitted their bids. |
| **16** | **End the Technical Stage** At the Technical Stage deadline (or earlier if all responses are in), click "End Technical Stage." The RFQ stage will not open until the Technical Stage is ended. |
| **17** | **Technical Evaluation** Evaluators log in and assess each vendor's technical responses, assigning preferences (see Section 7). After all evaluations are complete, the buyer reviews results. |
| **18** | **End the RFQ Stage** At the RFQ deadline, click "End RFQ Stage." All vendor bids are now locked. The bids remain encrypted until unlocked via OTP. |
| **19** | **Unlock Bids (OTP Process)** Enter the OTP received on your registered mobile number to decrypt and view individual vendor bids. See Section 9 for the full OTP unlock process. |
| **20** | **Review Master QCS** The Master QCS (Quote Comparison Sheet) displays all vendor prices side by side. Use this to compare bids and identify the most competitive vendor for awarding. |
| **21** | **Award and Create PO** Select the winning vendor and initiate the award process (see Section 10): Create PO → Fill PO details → Add Scope of Work and Basis of Award → Submit Proposal → Approval workflow. |

## Before Publishing — Checklist

| Verify before clicking Publish |
| --- |
| Correct Server ID selected (455, 454, 419, 433, 444, 451, or 452)All line items added with correct quantities and UOMCategory L1 selected (LIFT, HVAC, MHE, DG, CNF, COLD ROOM, AWNING, or IFMS)SOW / DOR documents attachedT&C document attached or typedCorrect RFQ template selected (MRO SPOT, ARC, Transportation B2B, OD Transportation B2B)Technical Assessment assigned and evaluators added (if Technical Stage included)All relevant vendor POCs invitedEvent schedule set with sufficient vendor response timePurchase Group (PG3) and Purchase Organization (RP01/RP00) correctly selected |

# 6. Buyer Guide: Creating a Sourcing Request (with BAFO)

The Sourcing Request approach is ideal when you have many items to source and want to fill them all in an Excel sheet rather than searching one by one. The Excel approach is faster for bulk requirements. Sourcing Request also uniquely supports the BAFO (Best and Final Offer) stage for final price negotiation.

## Part A: Creating the Sourcing Request

| 1 | Navigate to Events** Log in to Procol and click on "Events" in the left navigation menu. |
| --- | --- |
| **2** | **Create a New Event** Click "New Event" (top right button). A popup appears asking you to choose the event type. |
| **3** | **Select Sourcing Request** Choose "Sourcing Request." This selects the Excel-based bulk upload approach. |
| **4** | **Select the Server ID** Choose the correct Server ID (455, 454, 419, 433, 444, 451, or 452) for the Reliance Retail entity running this procurement. |
| **5** | **Select Template Type** Choose the appropriate Sourcing Request Excel template: MRO Services Sourcing Request or E2E Transportation. This determines the columns in the downloadable Excel file. |
| **6** | **Download the Excel Template** Click "Download Template" to get the pre-formatted Excel file with specific columns that must be filled correctly for the upload to work. |
| **7** | **Fill the Excel Template** Open the downloaded Excel and fill in all required columns: Service Code or Item Description, Quantity, Unit of Measure, and any other required fields. Do NOT change column headers or sheet structure. |
| **8** | **Upload the Filled Sheet** Back in Procol, click "Upload Sheet" and select your completed Excel file. Procol parses the file and creates line items from your data. Review the imported items for accuracy. |
| **9** | **Create the Project** Once line items are confirmed, click "Create Project." The event is created with all your items. |
| **10** | **Select Event Stages** Choose Technical Stage, RFQ Stage, or both (Technical + RFQ is most common). |
| **11** | **Select RFQ Template** Choose the RFQ template: MRO Services Sourcing Request maps to MRO Services SPOT for the RFQ; E2E Transportation maps to the relevant transport template. |
| **12** | **Fill Buyer & Event Information** Same as eRFX: buyer details, Category L1, SOW, T&C, Purchase Group (PG3), and Purchase Organization (RP01/RP00). |
| **13** | **Configure Technical Stage** Add the Technical Assessment questionnaire and evaluators if Technical Stage is included. |
| **14** | **Add Participants** Invite vendor POCs. |
| **15** | **Set Schedule and Publish** Set the event schedule and publish. Vendors receive notification emails. |
| **16** | **Monitor, End Stages, Unlock Bids** Same process as eRFX: monitor Participation Summary, end stages, unlock bids via OTP. See Sections 9 and 10. |

## Part B: Converting to BAFO (Best and Final Offer)

After reviewing initial RFQ responses, you can optionally trigger a BAFO round to invite shortlisted vendors to submit their absolute best final price. This is available only in Sourcing Request events (not in eRFX projects).

| What is BAFO? |
| --- |
| BAFO stands for Best and Final Offer. After the initial RFQ stage closes and bids are unlocked, if the buyer wants to further negotiate or prices are higher than budget, a BAFO round can be created. Only selected (shortlisted) vendors from the RFQ stage are invited to the BAFO round. BAFO is a one-time opportunity for vendors to improve their bid — they should know this is their final chance. The BAFO round follows the same process as the RFQ stage: publish → vendors submit → end → unlock → compare → award. |

| 1 | Go to Event Settings** After the RFQ stage is closed and bids are unlocked, navigate to the event and click on "Settings." |
| --- | --- |
| **2** | **Select Convert to BAFO** In Settings, click "Convert to BAFO." A confirmation prompt appears. Confirm to proceed. |
| **3** | **BAFO Event is Created** A new BAFO stage is automatically created within the same event. The BAFO template used is: MRO Services SPOT BAFO. |
| **4** | **Add Items to BAFO** Select which line items from the original RFQ will be included in the BAFO round. You can include all items or only the items where you want further price negotiation. |
| **5** | **Select BAFO Participants** Choose which vendors from the RFQ stage will be invited to the BAFO round. Typically, only shortlisted / competitive vendors are invited. |
| **6** | **Set BAFO Schedule** Set the BAFO start and end date/time. Vendors need adequate time to review and improve their original bid. |
| **7** | **Publish BAFO** Click "Publish." Invited vendors receive a BAFO notification email. The BAFO event is now live. |
| **8** | **Monitor BAFO Responses** Track BAFO responses in the Participation Summary. Use "Notify" to remind vendors who have not yet submitted their BAFO bid. |
| **9** | **End the BAFO Stage** At the BAFO deadline, click "End BAFO Stage." All BAFO bids are locked. |
| **10** | **Unlock BAFO Bids (OTP)** Use the OTP unlock process (Section 9) to decrypt and view BAFO bids. |
| **11** | **Review Master QCS for BAFO** The Master QCS now shows the BAFO prices. Compare with original RFQ prices to see vendor improvements. |
| **12** | **Award and Create PO** Select the winning vendor from the BAFO round and proceed to create the Purchase Order (Section 10). |

# 7. Managing the Technical Stage (Evaluator Guide)

The Technical Stage is an assessment phase before commercial bidding. Vendors answer a standardized 12-question questionnaire about their capabilities. Evaluators review responses and assign preferences, determining which vendors qualify for the RFQ stage.

## Why the Technical Stage Matters

- Ensures only qualified, capable vendors proceed to price bidding
- Reduces risk of awarding to a vendor who cannot actually deliver the required service
- Creates a documented vendor assessment record for compliance and audit purposes
- Allows technical experts to evaluate without seeing commercial bids — reducing bias

## The 12 Technical Assessment Questions

Every Technical Stage in Reliance Retail's Procol events uses a standardized 12-question questionnaire. Vendors must answer all questions:

| Question | What Vendors Must Answer |
| --- | --- |
| **1. Equipment Type** | What type of equipment is involved in this scope of work? |
| **2. Type of Work** | What is the nature of the work — repair, maintenance, installation, AMC, or other? |
| **3. Scope of Work** | Describe your understanding of the scope of work for this requirement. |
| **4. Age of Equipment** | What is the age of the equipment or assets involved? |
| **5. Technical Certification** | Do you hold relevant technical certifications for this work? List certifications with validity dates. |
| **6. Warranty of Repair (Years)** | What warranty period do you offer on your repair/service work (in years)? |
| **7. Safety Compliance** | Are you compliant with relevant safety standards and regulations? Provide details. |
| **8. Spare Parts** | Do you have availability of genuine or OEM-compatible spare parts? Describe your spare parts capability. |
| **9. Delivery Time of Spare Parts** | What is your standard delivery timeline for spare parts (in days)? |
| **10. OEM Details** | Are you an OEM-authorized service provider? If yes, provide OEM authorization details. |
| **11. Emergency Support** | Do you offer 24x7 emergency support? What is your emergency response time? |
| **12. Quality Checks** | What quality check processes do you follow after completing repair or service work? |

## Evaluator: How to Evaluate Technical Responses

| 1 | Navigate to the Event** Log in to Procol and open the sourcing event where you have been assigned as an Evaluator. |
| --- | --- |
| **2** | **Go to Technical Stage Responses Tab** Click on the "Technical Stage" tab within the event. You will see a list of all vendors who have submitted their technical responses. |
| **3** | **Open a Vendor's Response** Click on a vendor's name to view their responses to all 12 questions. Review each answer carefully against the Reliance Retail requirements and the event specifications. |
| **4** | **Add Your Evaluation** Click "Add Evaluation" (or "Edit Evaluation" if you have already saved a draft). The evaluation form opens. |
| **5** | **Assign an Evaluation Preference** Select one of the following preferences for the vendor:Approved — First Preference: Best qualified vendor, most preferred for this requirementApproved — Second Preference: Highly qualified, second choiceApproved — Third Preference: Qualified, third choiceApproved — Fourth Preference: Acceptable, fourth choiceApproved — Fifth Preference: Marginally acceptable, fifth choiceRejected: Vendor does not meet requirements (mandatory remarks required)Note: "Rejected" status requires you to enter mandatory remarks explaining the reason for rejection. |
| **6** | **Add Remarks (for Rejected vendors)** If you select "Rejected," you must type your reasons in the mandatory remarks field. This creates an audit record and helps the buyer communicate the rejection reason. |
| **7** | **Save Your Evaluation** Click "Save" to save your evaluation. You can edit it again before the Technical Stage officially closes. |
| **8** | **Evaluate All Vendors** Repeat the process for every vendor who has submitted a technical response. Do not skip any vendors. |
| **9** | **Buyer Reviews Evaluations** After all evaluators submit their preferences, the buyer reviews the aggregate scores and decides which vendors qualify for the RFQ stage. |

| Evaluator Important Notes |
| --- |
| **Rejection requires mandatory remarks:** If you select "Rejected," you MUST enter your reasoning in the remarks field. The system will not let you save without remarks for rejected vendors.**Confidentiality:** Vendors CANNOT see each other's technical responses or evaluation preferences.Evaluators do not see commercial (price) bids at this stage — this ensures unbiased technical assessment.**Multiple evaluators:** If the buyer has assigned multiple evaluators, each evaluator submits their own preference independently. The buyer sees all evaluator preferences and makes the final qualification decision. |

# 8. Managing the RFQ (Commercial) Stage

The RFQ (Request for Quotation) stage is where vendors submit their price bids. By the time this stage opens, vendors have either already passed the Technical Stage (if applicable) or all invited vendors are eligible to bid.

## What Vendors Submit in the RFQ Stage

Depending on the template selected, vendors fill in various commercial fields. Key fields include:

| Field | What It Means |
| --- | --- |
| **Item-wise Pricing** | Price per unit for each line item in the event. Vendors enter the unit price; total value is auto-calculated based on quantity set by the buyer. |
| **Offer Reference Number** | The vendor's own internal quote/reference number from their records. Used for tracking during negotiation and purchase order. |
| **Warranty (Months)** | Warranty period offered in months from date of delivery or commissioning of the service/equipment. |
| **Incoterms** | The delivery term selected from Reliance-specific options: AN3-Annexure III-STO, DEQ-Delivered ex Quay, DEX-Export STO-Duty Paid Exports, EJW-EXCISE JW, EXP-Export STO-FOR, EXW-Ex-works. See Section 13 for details. |
| **Deviation to SOW/DOR/T&C** | Vendors declare any deviation from the Scope of Work, Definition of Requirements, or Terms & Conditions. If left blank, full compliance is assumed. |
| **Additional Remarks** | Any commercial notes or clarifications the vendor wants to communicate to Reliance Retail. |

## Buyer: Monitoring RFQ Responses

- Track real-time response status via the Participation Summary: Invited / Seen / Bid Placed / Bid Not Placed
- Use the "Notify" button to send reminder emails to vendors who have not yet submitted their bids
- Individual vendor quotes are NOT visible until the RFQ deadline passes (sealed bid process)
- After the deadline, use the OTP process (Section 9) to unlock and view all bids
- The Master QCS shows all vendor prices side by side for comparison

| Sealed Bid Process |
| --- |
| All vendor bids are encrypted and sealed until the RFQ stage officially ends. Even the buyer cannot see individual vendor prices while the RFQ stage is open. This ensures a fair and competitive process. After the stage ends, bids are unlocked one at a time using an OTP sent to the buyer's registered mobile number. |

# 9. Unlocking Bids After Evaluation (OTP Process)

After the RFQ stage (or BAFO stage) ends, vendor bids are sealed and encrypted. To view individual vendor prices, the buyer must go through an OTP-based unlock process. This security measure ensures bid integrity and prevents premature disclosure of vendor prices.

## Why OTP Unlock?

- Bids are sealed to prevent tampering or premature disclosure during the evaluation period
- The OTP (One-Time Password) is sent to the buyer's registered mobile number — only an authorized person can unlock bids
- Each bid is unlocked individually, creating an audit trail of when each bid was accessed
- This process is required for both RFQ stage bids and BAFO stage bids

## Step-by-Step: OTP Bid Unlock Process

| 1 | End the RFQ / BAFO Stage** First, officially end the RFQ Stage (or BAFO Stage) by clicking "End RFQ Stage" (or "End BAFO Stage") in the event. The stage must be ended before unlock is possible. |
| --- | --- |
| **2** | **Navigate to Bid Unlock** In the event, find the "Unlock Bids" option. This is typically in the event actions or response summary section. |
| **3** | **Request OTP** Click "Unlock Bid" for the first vendor. The system sends an OTP to your registered mobile number. The OTP is time-limited (valid for a short window, typically a few minutes). |
| **4** | **Enter OTP** Enter the OTP you received on your mobile phone into the OTP field in Procol. Click "Verify / Submit." |
| **5** | **Bid is Unlocked** The selected vendor's bid is now visible — you can see their item-wise prices, offer reference number, warranty, incoterm, and other commercial details. |
| **6** | **Repeat for Each Vendor** Repeat the OTP process for each vendor whose bid you want to unlock. Each unlock request generates a new OTP. You can unlock all vendors' bids to compare prices. |
| **7** | **View Master QCS** After unlocking bids, navigate to the "Master QCS" tab. This shows all unlocked vendor prices in a side-by-side comparison table. Use this to identify the most competitive bid for awarding. |

| OTP Tips |
| --- |
| Make sure your registered mobile number is active and has signal when you initiate the unlock process.The OTP is valid for a short time window — enter it promptly after receiving it.If the OTP expires before entry, you can request a new OTP.Each OTP request unlocks one vendor's bid. For events with 5 vendors, you will receive 5 separate OTPs (one per vendor unlock).The Master QCS is only populated after bids are unlocked — it will be empty or incomplete until you unlock all relevant vendor bids. |

# 10. Awarding the Event & Creating a Purchase Order

After reviewing the Master QCS and selecting the winning vendor, the buyer initiates the award process in Procol. This includes creating a Purchase Order (PO), adding the Scope of Work and Basis of Award, and routing the proposal through an approval workflow.

## Overview: Award to PO Flow

| Award Process Flow |
| --- |
| Start Awarding → Select Vendor & Items → Create PO → Fill PO Details → Add Scope of Work + Basis of Award → Add Attachments → Submit Proposal → Approval Workflow (Step 1 → Step 2) → PO Approved |

## Step-by-Step: Creating the Purchase Order

| 1 | Navigate to Master QCS** After unlocking all bids, go to the Master QCS tab. Review all vendor prices and select the winning vendor based on price, technical preference, and other criteria. |
| --- | --- |
| **2** | **Click "Start Awarding"** Click the "Start Awarding" button in the event. This initiates the award process. |
| **3** | **Select Vendor and Items for Award** Choose the vendor to whom you are awarding the contract. Select the specific line items being awarded to this vendor (you can split award across vendors for different items if needed). |
| **4** | **Click "Create PO"** After selecting the vendor and items, click "Create PO" to begin filling in the Purchase Order details. |
| **5** | **Fill PO Details — Header Fields** Complete the PO header information:Pr no. (Purchase Requisition number)Liquidated Damages clause (if applicable)Service Category and SubCategoryCompliance CategoryNon L1 Vendor (flag if awarding to non-lowest bidder — requires justification)Order is placed on Single Bidder (flag if applicable) |
| **6** | **Fill PO Details — Accounting Fields** Complete the accounting/cost allocation fields:G/L Account (General Ledger account code)Matl Group: SERVICES-990501001WBS Element (Work Breakdown Structure element for project tracking)Tracking Number (internal tracking reference) |
| **7** | **Set Payment Terms** Select the standard Reliance Retail payment term: SC30 — Within 30 Days from Invoice Scroll Date. |
| **8** | **Add Scope of Work** In the "Scope of Work" section, attach or type the detailed scope of work for this purchase order. This becomes part of the PO documentation. |
| **9** | **Add Basis of Award** In the "Basis of Award" section, explain why this vendor was selected — price comparison rationale, technical preference rank, savings vs. budget, etc. This is important for governance and audit. |
| **10** | **Add Additional Attachments** Attach any additional supporting documents: vendor quotation, technical evaluation summary, financial comparison, approval notes, or any other relevant documents. |
| **11** | **Submit Proposal** Click "Submit Proposal" to send the PO for approval. The proposal enters the approval workflow. |
| **12** | **Approval Workflow** The PO proposal goes through an approval workflow (typically 2 approval steps). Approvers receive email notifications. You can track the approval status in Procol under the event/proposal section. |
| **13** | **PO Approved** Once all approvers approve, the Purchase Order is confirmed. The vendor will be notified of the PO, and the procurement event is complete. |

## Key PO Fields — Reference

| Field | Reliance Retail Standard Value |
| --- | --- |
| **Purchase Group** | PG3 \| Reg. PO W/O HR/IR (PG3) — standard for Reliance Retail service procurement |
| **Purchase Organization** | RP01 \| RR Lotus Purc... or RP00 \| Reliance Purch Org — select based on entity |
| **Payment Terms** | SC30 — Within 30 Days from Invoice Scroll Date |
| **Matl Group** | SERVICES-990501001 — standard material group for services |
| **Non L1 Vendor** | Must be flagged and justified if awarding to a vendor who is NOT the lowest bidder |
| **Single Bidder** | Flag if only one vendor submitted a bid — requires additional justification per Reliance procurement policy |

# 11. Vendor Guide: How to Submit a Quote via SRM Portal

This section is written from the vendor's perspective. If you are a vendor invited to a Reliance Retail sourcing event on Procol, follow these steps to access the portal, participate, and submit your quote.

## Getting Access to the Event

| Vendor Access Note |
| --- |
| Vendors access Procol through the Reliance Retail SRM Portal at ietsrm.ril.com. You do not need a separate Procol account. Access is granted when Reliance Retail adds you as an invited POC (Point of Contact) to a specific event. You will receive an email notification when you are invited. Navigation: Log in to ietsrm.ril.com → Additional Services → Sourcing and Procurement → Service RFQ/RFX |

## Step-by-Step: Vendor Participation Process

| 1 | Receive Email Invitation** When Reliance Retail adds you as a POC to a sourcing event, you receive an email notification with: event name, event deadline, and a link or instructions to access the SRM portal. |
| --- | --- |
| **2** | **Log In to SRM Portal** Go to ietsrm.ril.com and log in with your registered SRM credentials. Contact your Reliance Retail buyer if you do not have credentials. |
| **3** | **Navigate to Procol** After logging in, navigate to: Additional Services → Sourcing and Procurement → Service RFQ/RFX to enter the Procol platform. |
| **4** | **Find the Live Event** In Procol, navigate to the Events section. You will see events you have been invited to. Locate the event with a "Live" or "Open" status. |
| **5** | **Review Event Details** Click on the event to open it. Carefully read: event description, Scope of Work (SOW), technical specifications, Terms & Conditions (T&C), all line items and quantities, and event deadlines. Download all attached documents. |
| **6** | **Confirm Participation** After reviewing, confirm your participation status:Click "I will participate" — committing to submit a responseClick "I will not participate" — declining (must provide a reason)You must confirm before the Technical Stage or RFQ Stage window opens. |
| **7** | **Complete the Technical Stage** If the event has a Technical Stage, navigate to the "Technical" tab. Answer all 12 questions (see Section 7 for question details). Upload any required documents (certifications, credentials, OEM authorization letters, etc.). Review your answers and click "Submit Technical Response." |
| **8** | **Wait for Technical Evaluation** After submitting, wait for the buyer's technical evaluation. If you are Approved, you will receive notification that the RFQ Stage is open. If you are Rejected, you will be notified (you cannot proceed to pricing). |
| **9** | **Navigate to RFQ Tab** Once the RFQ Stage opens and you have been approved, log in and navigate to the "RFQ" tab within the event. |
| **10** | **Enter Item-wise Prices** Fill in your unit price for each line item you want to bid on. The quantities are set by Reliance Retail — you only enter the price. The total value is auto-calculated. |
| **11** | **Fill Commercial Details** Complete all commercial fields:Offer Reference Number — your internal quote referenceWarranty (Months) — warranty period you are offeringIncoterms — select the applicable delivery term (AN3, DEQ, DEX, EJW, EXP, or EXW)Deviation to SOW/DOR/T&C — declare any deviations (leave blank if fully compliant) |
| **12** | **Declare Deviations (if any)** If you cannot comply with any specific SOW/DOR/T&C requirement, declare each deviation clearly: specify the clause you are deviating from and your alternative proposal. Leaving this blank means full compliance. Non-disclosure of deviations can lead to bid rejection at the award stage. |
| **13** | **Review Before Submission** Before clicking Submit, verify: all item prices are filled, Offer Reference Number entered, warranty and Incoterms selected, all deviations declared, any required attachments uploaded. |
| **14** | **Submit Your Quote** Click "Submit Quote." You receive a confirmation with a submission timestamp. Save this as proof of submission. |
| **15** | **BAFO Round (if applicable)** If the buyer triggers a BAFO round, you will receive a notification. The BAFO process is identical to the RFQ process — review your original bid and submit an improved (lower) price. This is your final opportunity to improve your bid. |
| **16** | **Wait for Award Communication** After the RFQ/BAFO deadline, the buyer evaluates quotes and makes an award decision. You will receive either: an award notification (if you win), a BAFO invitation (if shortlisted for another round), or a regret communication (if you do not win). |

# 12. Template Types Explained

Procol provides different templates for different types of procurement. Selecting the right template ensures vendors fill in the most relevant commercial information. Here is a complete reference for Reliance Retail's available templates:

## eRFX Project Templates

| Template Name | When and How to Use |
| --- | --- |
| **MRO Services SPOT** | Maintenance, Repair & Operations — one-time (SPOT) purchase. Use for: specific immediate requirements, spare parts for machine breakdown, one-time civil repair, operational service needs. Key fields: unit price, delivery period, warranty, Incoterms, GST, payment terms. |
| **ARC (Annual Rate Contract)** | Fix the rate for materials/services for the entire year. Use for: recurring same requirements, monthly housekeeping, regular AMC (Annual Maintenance Contracts), consumables supply. Key fields: unit rate, contract period (start-end date), min/max quantities, payment terms. |
| **Transportation B2B** | Logistics and transportation procurement — business-to-business freight. Use for: trucking, freight carriers, transporting materials between locations. Key fields: rate per trip or per tonne-km, origin/destination, vehicle type, transit time. |
| **OD Transportation B2B** | Over-Dimensional (OD) Transportation for large/heavy equipment. Use for: moving equipment that requires special permits, wide-load transport, heavy machinery relocation. Key fields: similar to Transportation B2B with OD-specific requirements. |

## Sourcing Request Templates

| Template Name | When and How to Use |
| --- | --- |
| **MRO Services Sourcing Request** | The Excel-upload equivalent of MRO Services SPOT. Use for bulk MRO requirements — multiple maintenance/repair/operations items uploaded at once. The RFQ template maps to MRO Services SPOT for the commercial bidding stage. |
| **E2E Transportation** | End-to-End Transportation sourcing via Excel upload. Use for bulk transportation requirement uploads covering multiple routes, vehicle types, or time periods. |

## BAFO Template

| MRO Services SPOT BAFO |
| --- |
| This template is automatically selected when a Sourcing Request event is converted to BAFO. It is the BAFO-round equivalent of MRO Services SPOT. When to use: You do not select this manually — Procol automatically uses this template when you click "Convert to BAFO" in the event Settings. Fields: Same as MRO Services SPOT but with the context that this is the vendor's Best and Final Offer. |

| Quick Template Selection Guide |
| --- |
| One-time service or material purchase (any quantity, few items) → MRO Services SPOT (eRFX)Many MRO items to upload at once → MRO Services Sourcing Request (Sourcing Request)Annual contract, recurring purchases at fixed rate → ARC (eRFX)Standard freight / trucking → Transportation B2B (eRFX)Over-dimensional / special transport → OD Transportation B2B (eRFX)Bulk transportation routes via Excel → E2E Transportation (Sourcing Request)After initial RFQ, want best final price → Convert to BAFO (auto-uses MRO Services SPOT BAFO) |

# 13. Incoterms Reference

Incoterms (International Commercial Terms) are standardized trade terms that define exactly WHERE and WHEN the responsibility for goods or services transfers from the vendor to Reliance Retail. In Procol, vendors select an Incoterm when submitting their quote. Reliance Retail uses a specific set of Incoterms within Procol.

## Core Concept: The Risk and Cost Transfer Point

| Simple Explanation of Incoterms |
| --- |
| Every Incoterm defines a "hand-off point." Up to that point, the VENDOR pays for transport, customs, and bears all risk. After that point, Reliance Retail takes over all costs and risks. Example: EXW (Ex-works) means Reliance Retail is responsible for everything from the moment goods/services are completed at the vendor's location. DEQ means the vendor handles everything until delivery at Reliance Retail's destination. Always compare vendor quotes on the same Incoterm basis. A lower EXW price may cost more than a slightly higher DEQ price when freight costs are added. |

## Reliance Retail Incoterms in Procol

| Incoterm Code | What It Means for Reliance Retail |
| --- | --- |
| **AN3 — Annexure III-STO** | Stock Transfer Order under Annexure III terms. Used for inter-company or intra-company stock transfers within the Reliance group. Defines specific Reliance internal transfer pricing and logistics terms. |
| **DEQ — Delivered ex Quay** | Vendor is responsible until goods are delivered and unloaded at the destination quay (port/loading point). Reliance Retail handles onward transport to the site/store from the quay. Vendor handles all freight, insurance, and unloading. |
| **DEX — Export STO-Duty Paid Exports** | Delivered for export Stock Transfer Orders with all duties paid by the vendor. Used when materials are being exported from a Reliance entity. Vendor handles all costs including export duty. |
| **EJW — EXCISE JW** | Excise Job Work terms — used specifically for job work (processing/fabrication) under excise/GST job work provisions. The vendor receives materials, processes them, and returns the finished goods. |
| **EXP — Export STO-FOR** | Export Stock Transfer Order, Free on Rail/Road (FOR). Vendor delivers to the specified export point (rail head or loading point). Reliance Retail arranges export from that point. |
| **EXW — Ex-works** | Maximum responsibility for Reliance Retail — the vendor makes goods or completed services available at their own location. Reliance Retail arranges all transport, insurance, and customs from the vendor's premises. The vendor's responsibility ends at their own factory/office gate. |

| Practical Guidance |
| --- |
| For domestic service procurement (maintenance, repair, HVAC, lifts, etc.), EXW is most common — the vendor completes the service at the Reliance Retail site and the "delivery" point is effectively the site itself. For material supply with delivery to Reliance Retail sites, DEQ terms mean the vendor handles delivery to site, while EXW means Reliance Retail arranges pickup from the vendor. Always specify the expected Incoterm in the event SOW/T&C so all vendors quote on a consistent basis. When vendors quote different Incoterms, you must adjust prices to compare like-for-like. |

# 14. Reliance Retail: Field Values Quick Reference

This section provides a quick reference for all Reliance Retail-specific field values used in Procol. Use this when creating events to ensure you select the correct values.

## Server IDs

When creating a new event, select the Server ID that corresponds to the Reliance Retail entity or region running this procurement:

| Server ID | Entity / Use |
| --- | --- |
| **455** | Reliance Retail Server — Zone/Entity 455 |
| **454** | Reliance Retail Server — Zone/Entity 454 |
| **419** | Reliance Retail Server — Zone/Entity 419 |
| **433** | Reliance Retail Server — Zone/Entity 433 |
| **444** | Reliance Retail Server — Zone/Entity 444 |
| **451** | Reliance Retail Server — Zone/Entity 451 |
| **452** | Reliance Retail Server — Zone/Entity 452 |

## Category L1 (Category Level 1)

Select the Category L1 that best describes the type of service or equipment being procured:

| Category L1 | Description |
| --- | --- |
| **LIFT** | Elevator and escalator maintenance, repair, and installation services |
| **HVAC** | Heating, Ventilation, and Air Conditioning services — maintenance, AMC, repair |
| **MHE** | Material Handling Equipment — forklifts, pallet trucks, conveyors, etc. |
| **DG** | Diesel Generator — maintenance, repair, AMC, and fuel-related services |
| **CNF** | Clearing and Forwarding — logistics, freight forwarding, customs services |
| **COLD ROOM** | Cold storage room maintenance, repair, and temperature control services |
| **AWNING** | Awning, facade, and external covering maintenance and installation |
| **IFMS** | Integrated Facility Management Services — combined multi-service facility management |

## Purchase Group & Purchase Organization

| Field | Value |
| --- | --- |
| **Purchase Group** | PG3 \| Reg. PO W/O HR/IR (PG3) — standard for Reliance Retail regular Purchase Orders without Holding Room or Inspection Report requirement |
| **Purchase Organization — Standard** | RP01 \| RR Lotus Purc... — primary Reliance Retail purchase organization for most procurement events |
| **Purchase Organization — Alternate** | RP00 \| Reliance Purch Org — alternate purchase organization; use based on internal routing requirements |
| **Payment Terms** | SC30 — Within 30 Days from Invoice Scroll Date — standard Reliance Retail payment term for service vendors |
| **Material Group (Services)** | SERVICES-990501001 — standard material group code to use for all service-category line items in PO creation |

## Incoterms Reference

| Code | Full Name & Meaning |
| --- | --- |
| **AN3** | Annexure III-STO — inter-company stock transfer |
| **DEQ** | Delivered ex Quay — delivered to destination port/point, unloaded |
| **DEX** | Export STO-Duty Paid Exports — export stock transfer, all duties paid |
| **EJW** | EXCISE JW — excise job work terms |
| **EXP** | Export STO-FOR — export stock transfer, free on road/rail |
| **EXW** | Ex-works — vendor makes goods available at their location |

## Templates at a Glance

| Template Name | When to Use |
| --- | --- |
| **MRO Services SPOT** | eRFX — one-time MRO services/items |
| **ARC** | eRFX — Annual Rate Contract (recurring, fixed rate) |
| **Transportation B2B** | eRFX — standard B2B freight/logistics |
| **OD Transportation B2B** | eRFX — over-dimensional/special transport |
| **MRO Services Sourcing Request** | Sourcing Request (Excel) — bulk MRO items |
| **E2E Transportation** | Sourcing Request (Excel) — bulk transport routes |
| **MRO Services SPOT BAFO** | Auto-selected when converting to BAFO |

# 15. Frequently Asked Questions

## Buyer FAQs

| Question | Answer |
| --- | --- |
| **Which Server ID should I select?** | Select the Server ID corresponding to the Reliance Retail entity, zone, or plant running this procurement. The available IDs are: 455, 454, 419, 433, 444, 451, 452. If unsure, check with your manager or the Procol system administrator for the correct mapping to your entity. |
| **Can I edit an event after publishing?** | Limited edits are possible after publishing (e.g., extending the deadline, adding documents). Major edits like changing line items or stages may require ending and re-creating the event. Always consult the Procol administrator before making major changes to a live event. |
| **What if a vendor says they did not receive the invitation?** | Verify the vendor POC's email address in Procol is correct. You can resend the invitation from within the event. Advise vendors to check their spam/junk folder. Also confirm the vendor has valid SRM portal access at ietsrm.ril.com. |
| **Can I add more vendors after publishing?** | Yes, typically you can add additional vendor POCs even after publishing, as long as the event deadline has not passed. The new vendor receives an invitation notification. |
| **When should I use eRFX vs. Sourcing Request?** | Use eRFX when you have a small, well-defined set of items to source individually. Use Sourcing Request when you have many items (or recurring bulk requirements) that are easier to upload via Excel. Use Sourcing Request when you anticipate needing a BAFO round. |
| **What is the difference between Category L1 and the Template?** | Category L1 (LIFT, HVAC, MHE, etc.) classifies the TYPE of service/equipment being procured — it is for reporting and routing. The Template (MRO SPOT, ARC, etc.) determines the COMMERCIAL FIELDS vendors fill in during the RFQ stage. Both must be selected correctly. |
| **Can I award to a vendor who is not the lowest bidder?** | Yes, but you must flag "Non L1 Vendor" in the PO details and provide a written justification (e.g., technical preference, single source, past performance). This is required for compliance and audit. |
| **What happens if no vendor responds?** | If no vendor submits a bid by the deadline, you can extend the deadline, add new vendors, or re-evaluate whether the event requirements need clarification. Always inform your manager if a critical event gets no responses. |
| **Is there an audit trail in Procol?** | Yes. Procol maintains a complete audit trail of all actions — event creation, vendor responses, evaluator scores, buyer actions, bid unlock times, and award decisions. This is accessible for governance and audit requirements. |

## Vendor FAQs

| Question | Answer |
| --- | --- |
| **I cannot log in to ietsrm.ril.com. What should I do?** | Try resetting your SRM portal password via the "Forgot Password" link. If that does not work, contact the Reliance Retail buyer who invited you — they can have your SRM portal access reviewed. Do not attempt to create a new account independently. |
| **I can log in but cannot see the event I was invited to.** | Navigate to: Additional Services → Sourcing and Procurement → Service RFQ/RFX. If the event still does not appear, verify with your buyer that your email address/user ID is correctly registered as a POC on that specific event. |
| **Can I modify my submission after clicking Submit?** | Typically NO — once submitted, your bid is locked. Some events allow resubmission before the deadline (the "Revise Bid" option may appear). Always review your quote carefully before submitting. |
| **What happens if I click "I will not participate"?** | You are declining the event and must provide a reason. You will not be able to submit a bid. Contact the buyer immediately if you change your mind — they may be able to reset your participation status before the deadline. |
| **What warranty period should I enter?** | Enter the warranty you offer in MONTHS (not years). For example, 12 months = 1 year warranty on the repair/service. The field label is "Warranty (Months)." |
| **Which Incoterm should I select?** | Select the Incoterm that matches your delivery arrangement. For services rendered at the Reliance Retail site, EXW is typically appropriate (you complete the service at their location). If unsure, refer to the event's T&C document or clarify with the buyer before bidding. |
| **Can I see what other vendors are quoting?** | NO. All bids are confidential and sealed. You cannot see competitor prices or technical responses at any stage. Only Reliance Retail's buyer can see all bids (after the OTP unlock process). |
| **What is the Offer Reference Number?** | This is YOUR internal reference number for this quotation — from your company's own quote register or ERP system. It helps you and the buyer track this specific quote during follow-up discussions and purchase order issuance. |
| **What should I do if I made an error in my submission?** | Contact the Reliance Retail buyer immediately. If the submission window is still open and the buyer has enabled re-bidding, you may be able to revise your quote. If the deadline has passed, the submitted bid stands as is. |
| **When will I know if I won?** | After the RFQ (or BAFO) deadline, the buyer evaluates quotes and makes an award decision. Timeline varies — typically 1–4 weeks after the deadline. You will be notified through Procol and/or email. |

# Quick Reference Summary

## Buyer: Process Flow at a Glance

| eRFX PROJECT | SOURCING REQUEST (+ BAFO) |
| --- | --- |
| Events → New Event → eRFX ProjectSelect Server ID (455/454/419/433/444/451/452)Search & add line items by service code/descSelect Stages (Technical + RFQ)Select Template (MRO SPOT / ARC / Transport)Fill Buyer & Event Info (Category L1, SOW, T&C)Set Purchase Group (PG3) & Purchase Org (RP01)Add Technical Assessment & EvaluatorsInvite Vendor POCsSet Schedule → PublishMonitor Participation Summary (use Notify)End Technical Stage → Evaluators assessEnd RFQ Stage → Unlock Bids (OTP)Review Master QCS → Start AwardingCreate PO → Fill Details → Submit ProposalApproval Workflow → PO Confirmed | Events → New Event → Sourcing RequestSelect Server ID (455/454/419/433/444/451/452)Select Excel Template (MRO SR / E2E Transport)Download → Fill Excel → Upload SheetCreate ProjectSelect Stages → Select Template → Fill InfoSame as eRFX from here onwards...Publish → Monitor → End Stages → Unlock BidsReview Master QCS── OPTIONAL BAFO ROUND ──Settings → Convert to BAFO → ConfirmSelect items & vendors → Schedule BAFOPublish BAFO → Monitor → End BAFOUnlock BAFO Bids (OTP) → Review Master QCSStart Awarding → Create PO → Submit ProposalApproval Workflow → PO Confirmed |

## Vendor: Process Flow at a Glance

| 1 | Receive email invitation from Reliance Retail |
| --- | --- |
| **2** | **Log in to ietsrm.ril.com (SRM Portal)** |
| **3** | **Navigate: Additional Services → Sourcing and Procurement → Service RFQ/RFX** |
| **4** | **Find the Live Event and review all details + attachments** |
| **5** | **Click "I will participate" to confirm** |
| **6** | **Complete Technical Stage — answer all 12 questions and upload documents** Equipment Type, Type of Work, Scope of Work, Age of Equipment, Technical Certification, Warranty of Repair, Safety Compliance, Spare Parts, Delivery Time of Spare Parts, OEM Details, Emergency Support, Quality Checks |
| **7** | **Wait for Technical Evaluation result (Approved or Rejected)** |
| **8** | **Navigate to RFQ tab (if Approved)** |
| **9** | **Enter item-wise prices and fill commercial fields** Offer Reference No., Warranty (Months), Incoterms (AN3/DEQ/DEX/EJW/EXP/EXW), Deviation to SOW/DOR/T&C |
| **10** | **Review thoroughly and click Submit Quote** |
| **11** | **BAFO Round (if applicable) — submit best final price** Only if Reliance Retail triggers a BAFO round |
| **12** | **Wait for award communication** |

## Key Terms at a Glance

| Term | Quick Meaning |
| --- | --- |
| **Procol / Procure360** | Digital procurement platform used by Reliance Retail |
| **SRM Portal** | ietsrm.ril.com — vendor access point for all Procol events |
| **Portal Path** | Additional Services → Sourcing & Procurement → Service RFQ/RFX |
| **eRFX Project** | Create event by searching items one by one |
| **Sourcing Request** | Create event by uploading Excel bulk sheet (supports BAFO) |
| **Technical Stage** | 12-question vendor capability assessment before price bidding |
| **RFQ Stage** | Price bidding / commercial quote submission |
| **BAFO** | Best and Final Offer — optional final price round (Sourcing Request only) |
| **OTP Unlock** | One-Time Password process to decrypt sealed bids after stage ends |
| **Master QCS** | Quote Comparison Sheet — all vendor prices side by side |
| **Server ID** | 455 / 454 / 419 / 433 / 444 / 451 / 452 — Reliance Retail entity IDs |
| **Category L1** | LIFT, HVAC, MHE, DG, CNF, COLD ROOM, AWNING, IFMS |
| **Purchase Group** | PG3 \| Reg. PO W/O HR/IR (PG3) |
| **Purchase Org** | RP01 \| RR Lotus Purc... or RP00 \| Reliance Purch Org |
| **Payment Terms** | SC30 — Within 30 Days from Invoice Scroll Date |
| **Matl Group** | SERVICES-990501001 (for service POs) |
| **Incoterms** | AN3, DEQ, DEX, EJW, EXP, EXW — Reliance Retail delivery terms |
| **POC** | Point of Contact — specific vendor person invited to the event |
| **Evaluator** | Person who assigns Approved/Rejected preferences in Technical Stage |
| **Non L1 Vendor** | Flag used when awarding to a vendor who is not the lowest bidder |
| **SOW** | Scope of Work — defines what must be delivered |
| **DOR** | Definition of Requirements — technical specifications |
| **T&C** | Terms & Conditions of the procurement event |
| **Deviation** | Vendor's declared exception from SOW/DOR/T&C |
| **Offer Ref No.** | Vendor's own internal quote reference number |
| **MRO SPOT** | MRO Services SPOT — one-time maintenance/repair/operations |
| **ARC** | Annual Rate Contract — fixed rate for full contract year |

*— End of Document —*

*For system access issues or portal login problems, contact your Reliance Retail buyer or the Procol system administrator. For SRM portal access, visit ietsrm.ril.com.*
