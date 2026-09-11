# Customer support ticket workflow and SLAs

Status: current · Last reviewed: 2026-09 · Audience: customer success and engineering POCs · Source file: Customer Support Workflow.docx · Ingested: 2026-09-12

This document outlines the standardized workflow for handling customer support tickets, from intake to resolution, ensuring timely communication, prioritization, and adherence to Service Level Agreements (SLAs).

## Step 1: Ticket Intake
- A ticket is created when a customer submits a query via email or when a ticket is manually created internally within HubSpot (e.g., by a CSM).
- The ticket is logged in HubSpot with relevant details (e.g., customer name, query description, timestamp).
- A unique ticket ID is generated for tracking.The ticket is assigned an **Open** status.

## Step 2: Auto-Acknowledgement
- An automated response is sent to the customer to confirm receipt of their query.
- HubSpot sends an auto-generated email to the customer after a predefined time period (e.g., within 10 minutes of ticket creation).
- The email includes the ticket ID, a brief acknowledgment, and an estimated time for the initial response based on the configured first response SLA.

## Step 3: Initial Triaging
- A dedicated Customer Success Manager (CSM) reviews the ticket to classify, prioritize, and assign it appropriately.
Actions:

  - The CSM evaluates the ticket based on the query details and customer context.
The CSM assigns the following fields in HubSpot:

    - **Ticket Type**: Bug, Enhancement Suggestions, Support/Training Gap, or Service Request
    - **Ticket Status**: Pending Support, In Progress with Tech
    - **Priority_SS**: P0 - System Down, P1 - Critical, P2 - High, P3 - Medium, P4 - Low), based on the Prioritization Framework (see below).
  - If needed, the CSM may consult with Engineering/Product Point of Contact (POC) for technical insights or clarification.
  - The CSM sends a personalized confirmation email to the customer, acknowledging receipt, outlining next steps, and setting expectations for resolution or follow-up.
Prioritization Framework:

  - P0 - System Design (e.g., system downtime, data loss, security breach, affects all customers or major customer segments; SLA: Immediate attention, mitigation within hours).
  - P1 - Critical (e.g., significant functionality impacted; SLA: Mitigation within 1-2 business days).
  - P2 - High (e.g., minor functionality issues; SLA: Mitigation within 3-5 business days).
  - P3 - Medium (e.g., cosmetic issues, non-urgent inquiries; SLA: Mitigation within 5-10 business days).
  - P4 - Low ()
- SLA: The first response SLA (e.g., within 4 business hours) governs the timeline for this step.
Output:

  - Ticket is updated with type, status, and priority in HubSpot.
  - Customer receives a personalized acknowledgment email.
  - Ticket is routed to the appropriate team (e.g., Engineering/Product) if technical intervention is required.
- Owners: Dedicated CSM, with potential input from Engineering/Product POC.

## Step 4: Ticket Assignment and Technical Resolution
- The ticket is assigned to the relevant team (e.g., Engineering/Product) for resolution, with SLAs set based on priority.
A: Mitigation or temporary fix

Actions:

    - The ticket is assigned to an Engineering/Product POC based on the ticket type and priority.
The following SLAs are set in HubSpot:

      - Mitigation Date SLA: The target date for implementing a temporary fix or workaround (varies by priority, e.g., P1: within 24 hours, P2: within 2 days).
      - Close Due Date SLA: The target date for a permanent resolution (varies by priority, e.g., P1: within 3 days, P2: within 5 days).
    - The Engineering/Product team works on mitigating the issue and updates the ticket with progress notes in HubSpot.
    - Once a temporary fix or workaround is implemented, the POC updates the Ticket Status to Mitigated - Awaiting Permanent Fix.
Outputs:

    - Temporary fix or workaround is deployed (if applicable).
    - Ticket status is updated to Mitigated - Awaiting Permanent Fix in HubSpot.
    - Customers are notified of the mitigation and next steps (if applicable).
B: Permanent Fix and Closure

Actions:

    - The Engineering/Product team develops and deploys a permanent fix, adhering to the Close Due Date SLA.
    - The POC updates the ticket with resolution details and changes the Ticket Status to Resolved.
    - The CSM reviews the resolution, verifies with the customer (if needed), and closes the ticket by setting the Ticket Status to Closed.
    - A final email is sent to the customer, summarizing the resolution and inviting feedback.
Outputs:

    - Permanent fix is deployed.
    - Ticket is updated to Resolved and then Closed in HubSpot.
    - Customer receives a resolution summary email.
SLA:

  - Mitigation Date SLA and Close Due Date SLA govern the timelines for temporary and permanent fixes, respectively.
Owners:

  - Engineering/Product POC for technical resolution.
  - CSM for customer communication and ticket closure.

## Additional Considerations
Escalation Process:

  - If SLAs are at risk of being breached or if the customer escalates the issue, the CSM notifies the Engineering/Product Lead for expedited action.
  - Escalated tickets may be re-prioritized (e.g., from P2 to P1) based on impact and urgency.
Ticket Reopening:

  - If the customer reports that the issue persists after resolution, the ticket is reopened, and the status is reverted to In Progress with Tech for further investigation.

## Roles and Responsibilities
Customer Success Manager (CSM):

  - Triages tickets, assigns priorities, and communicates with customers.
  - Coordinates with Engineering/Product teams for technical resolution.
  - Ensures SLA adherence and ticket closure.
Engineering/Product POC:

  - Investigates and resolves technical issues.
  - Updates ticket status and provides technical notes in HubSpot.
  - Adheres to Mitigation and Close Due Date SLAs.

## Prioritization Framework
Severity

  - High: system crash, data loss, security breach
  - Medium: breaks major features but has workarounds
  - Low: cosmetic or minor issues with negligible impact
Impact on Users

  - High: affects all customers or major customer segments
  - Medium: affects a subset of users or specific workflows
  - Low: affects only edge cases or rarely used features
Business Impact

  - High: blocks payments, customer onboarding, or compliance
  - Medium: affects important but non-critical processes
  - Low: no direct business consequences
Frequency

  - Frequent: Happens regularly to most users
  - Rare: occurs under specific, and uncommon conditions
Availability of workarounds

  - No workaround: high priority
  - Easy workaround: low priority

## SLAs
| Priority | First Response SLA | Mitigation SLA | Close Ticket SLA |
| --- | --- | --- | --- |
| P0 - Urgent | 15 minutes | 4 hours | 4 hours |
| P1 - Critical | 30 minutes | 1 day | <= 2 days |
| P2 - High | 45 minutes | 2 days | <= 3 days |
| P3 - Medium | 2 hours | 3 days | <= 7 days |
| P4 - Low | 3 hours | NA | <= 30 days |
| Service Request (config change) | 2 hours | NA | 2 days |
| Enhancement / Feature Gap | 4 hours | Accept / Defer / Reject <= 5 days | As per prioritization |
| Support / Training | 2 hours | Same day | Same day |
