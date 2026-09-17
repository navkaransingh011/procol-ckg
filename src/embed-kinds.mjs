// The entity kinds embed-index builds cards for, in one place because two files need to agree.
//
// embed-index.mjs uses this as the default for --kinds; quality-check.mjs uses it to decide what
// "unembedded" means. When they disagree the failure is silent in the worst way: a newly embeddable
// kind is embedded fine but never coverage-checked, so the day it stops being embedded nothing says
// so, and semanticAnchor just returns fewer matches.
//
// Adding a kind: add it here. Nothing else needs to change.
export const EMBEDDED_KINDS = [
  "FEATURE",
  "DOCUMENT",
  "HANDLER",
  "DB_TABLE",
  "HTTP_ENDPOINT",
  "EXTERNAL_SERVICE",
  "HTTP_CALL_SITE",
  "SYMBOL",
  "UI_ROUTE",
  "UI_ACTION",
];
