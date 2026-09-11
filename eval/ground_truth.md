# Ground truth — answered by reading the source at procol-backend@1089000b3a, NOT the graph

Written before any model output was seen. Every claim carries the file:line I read it from.

## E1 — GET /activity_logs
- Handler: `Api::ActivityLogsController#index`, `app/controllers/api/activity_logs_controller.rb:4` (class :3, `< Api::ApiController`).
- Body, in order: reads `item_id`, `item_type`, `unit`, `client_company_id` from params (:5-8); `render_error_json(2)` unless item_id && item_type (:10); `render_error_json(101)` unless `is_allowed_to_view_activity(item_id, item_type, client_company_id)` (:11); `items = get_activities(item_id, item_type)` (:12, private def :40); `items = filter_activities(items, item_id, item_type)` (:13, private def :48); `Rails.logger.info` (:14); renders `ActiveModelSerializers::SerializableResource` with `ActivityLogSerializer`, `current_user: Current.user`, `unit`, `allow_multiple_po: is_multiple_po_allowed?(item_id, item_type)` (:15-24; private def :29, branches on `item_type == 'auction'`).
- Two routes serve it (subdomain-scoped duplicates): `/api/activity_logs` and `/activity_logs`.
- Which of these calls tests actually exercised I cannot know from source; that is graph-only knowledge.

## E2 — custom_configurations columns (db/schema.rb, create_table "custom_configurations", id: :serial)
| column | type | note |
|---|---|---|
| id | serial (integer PK) | |
| config_key | string | |
| item_type | string | polymorphic with item_id |
| item_id | integer | |
| modifications | jsonb | the value payload |
| status | integer, default 1 | model enum `{ in_active: 0, active: 1 }` (custom_configuration.rb:29) |
| company_id | integer | tenant scope |
| user_id | integer | |
| created_at | datetime, not null | |
| updated_at | datetime, not null | |
Indexes (model annotation, custom_configuration.rb header): `idx_custom_configurations_by_key_status_company (config_key, status, company_id)`, `idx_custom_configurations_lookup (item_type, company_id, item_id, status)`.

## E3 — lib/external_api (39 files)
ai_service, clara, contracts, currency_exchange_api, custom_search, dms, erp_next_api, fcm_api, golang, google_auth, google_sheets_api, heimdall, hubspot_api, lambda_invoker, lightspeed, lpo_data, oauth_request, open_ai_a, open_ai_client, openai, po_request, po_status, pr_dms, pr_hold, pr_status, procol_ftp, procol_recommendation_service, request, sales_force_api, sendin_blue_api, slack_logs, sms_services, staging_invoker, text_local_api, textract_document_ocr_service, uat_invoker, validation, whats_app_services.
(Some are wrappers/utilities rather than vendors: request, validation, staging_invoker, uat_invoker, lambda_invoker, oauth_request.)

## M1 — CustomConfiguration.cached_all_configs (app/models/custom_configuration.rb)
- Signature `def self.cached_all_configs(item:, config_key: nil)` (:164), Sorbet sig: item is Company or Template.
- Logic: `company_id = item.try(:company_id) || item.id` (:165); `custom_configs = cached_custom_config_hash(item.class.name, item.id, company_id)` (:166, def :126); `master_configs = MasterConfiguration.get_cached_master_configs[item.class.name] || []` (:167); `all_configs = master_configs.select { |_, cfg| cfg["company_id"].nil? || cfg["company_id"] == company_id }` (:169); `all_configs = all_configs.transform_values { |cfg| cfg["value"] }.merge(custom_configs)` (:170); returns `all_configs[config_key]` if a key is given, else the whole hash (:172).
- Resolution order it implements: master defaults (company_id nil) and company-specific masters are both kept, then `.merge(custom_configs)` so a custom row wins over any master.
- Cache: `after_save_commit :update_cache` (:32, def :188); cache key `"c_cfg_for_##{item_type}##{item_id}##{company_id}"` (:175-176).
- Bug: the fallback on :167 is `|| []` (an Array) but :169-170 call `select` with a 2-arity block and `.transform_values`, which is Hash-only -> `NoMethodError: undefined method 'transform_values' for []:Array` whenever `get_cached_master_configs` has no entry for that item class (any new model/company before its master config exists). Fix: change `|| []` to `|| {}` on :167. Confirmed by a real rspec run (spec/models/company_spec.rb:14 via Company#licensing_enabled? -> UserCompanyMapping#licensing_restrictions).
- Related: VPCParamsMixin.merge_vendor_invite_extra_fields! (app/services/vpc_network/concerns/vpc_params_mixin.rb:44) breaks on the nil return of this method for a missing key.

## M2 — /approval_workflow/approval_requests: frontend callers -> Rails actions
Routes (config/routes.rb:1135+, `scope :approval_requests, controller: 'approval_requests'` under approval_workflow -> controller `Api::ApprovalWorkflow::ApprovalRequestsController`):
- `post 'resolve_approval'` -> `#resolve_approval` (:1136); `post 'bulk_resolve'` -> `#bulk_resolve` (:1137); `get 'get_pending_approvals'` -> `#get_pending_approvals` (:1138); `get 'filter_options'` -> `#options` (:1139); `post ':id/withdraw_approval'` -> `#withdraw_approval` (:1140); further lines (search_approvers, approval_steps_details, index/show/create) exist beyond :1140 -- not read here.
Frontend call sites on dashboard main:
| file:line | path | likely action |
|---|---|---|
| src/redux/pendingTasks/api.js:10 | GET .../get_pending_approvals | #get_pending_approvals |
| src/redux/pendingTasks/api.js:23 | POST .../resolve_approval | #resolve_approval |
| src/views/projectProposal/withdrawApprovalModal/api.js:6 | POST .../:id/withdraw_approval | #withdraw_approval |
| src/views/vendorDetails/onboardingDetails/api.js:67 | POST /approval_workflow/approval_requests | #create |
| src/components/customApprovalStepper/api.js:5 | .../:id | #show |
| src/components/approverSearch/api.js:13 | .../:id/search_approvers?query= | #search_approvers |
| src/views/orderDetails/approvalCardSettings/api.js:5 | .../:id/approval_steps_details | #approval_steps_details |
| src/redux/orders/api.js:372 | `let url = ...` then appended | #index (query string added at runtime) |
Also earlier graph reads showed src/redux/approvals/api.js:21 (GET index) and :23 (filter_options -> #options).

## M3 — Clara access token
- Endpoint: `Api::UsersController#get_clara_ai_access_token` (app/controllers/api/users_controller.rb:25-36). Gate: `Current.workspace.has_clara_ai_access?(Current.user) || Current.workspace.restricted_clara_access_tools.present?` else `render_error_json(101)`. `has_clara_ai_access?` (company.rb:1166-1172) is a per-company user-id allowlist in `clara_identifier["user_ids"]` (or "all").
- Reuse: `Current.user.sessions.active.mcp.last&.access_token` (:29). Otherwise `Clara::Auth.new(Current.user, Current.workspace, Current.session).execute!` (:32-33).
- `Clara::Auth#execute!` (app/services/clara/auth.rb:11-22): calls `ExternalApi::Clara.get_auth_token({full_name, email, company_tenant_mapping_id})` (lib/external_api/clara.rb; BASE_URL from `ProcolVariable.fetch_by_key('CLARA_BASE_URL')`), takes `response["session"]["access_token"]`, `deep_dup`s the current session, sets `token_type = "mcp"`, `access_token = <clara token>`, `save!`. So Clara issues the token; Procol mirrors it as a Session row.
- token_type enum: `{ sourcing: 0, mcp: 1 }` (app/models/session.rb:33). `generate_access_token` is skipped for mcp (`return if self.mcp?`, :58) so the Clara-issued value is kept.
- Login also returns it: api/v1/users_controller.rb:63 and :371 set `@clara_access_token`; `app/views/api/v1/users/user_login.json.jbuilder:29-30` emits `clara_access_token`.
- Backend accepts it on requests via the `X-MCP-Token` header (app/controllers/concerns/api_auth.rb:47).
- Frontend: `redux/user/actions.js:227-229` -> `TOKEN.updateClaraToken(res.clara_access_token)`; `services/token.js:28-30` -> `store(CLARA_TOKEN_KEY, secret)` in localStorage under `"clara_access_token"` (constants/index.js:8); refresh via `fetchClaraAccessToken` (actions.js:357-361, `API.getClaraAccessToken`); cleared on logout in `utils/authHelpers.js:30`.

## C1 — GET /v1/trade/:id/quote_details/:quote_id
- Route: `get ':id/quote_details/:quote_id' => 'trade#quote_details'` (config/routes.rb:955, inside the v1 trade scope) -> `api/v1/trade#quote_details` -> `Api::V1::TradeController#quote_details` (app/controllers/api/v1/trade_controller.rb:643).
- Frontend callers (dashboard main): `src/views/vendorDetails/onboardingDetails/api.js:12` -- promisifiedXHR(`/v1/trade/${eventId}/quote_details/${sheetId}`, "GET"); `src/redux/orders/api.js:79` -- `let url = /v1/trade/${tradeId}/quote_details/${sheetId}` (then possibly appended). (`redux/orders/selectors.js:6728` only mentions it in a comment.)
- Body from source (:643-700): `authorize TradeRequest, :show?` (:644, Pundit -> TradeRequestPolicy#show?); `trade = TradeRequest.find_by_id(event_id)` (:647); `render_error_json(error_code, ...)` if a validation error is set (:649, the event validation lives in TradeControllerHelper#validate_event); `TemplateResponse.where.not(status: :in_active).find_by(item: trade, id: quote_id)` -> error 4 if blank (:666-667); optional `Proposal.find_by(id: proposal_id)` + `authorize(proposal, :show?)` (:671-672); builds `data[:user]` with `UserMinimalSerializer` and `data[:company]` with `CompanySerializer` (:680-694). Lines past :700 (the sheet/bids assembly) I did not read.
- Runtime-observed callees (graph, TracePoint): 25, including TradeRequestPolicy#show?, ApiAuth#pundit_user, TradeControllerHelper#validate_event, TradeTemplateHelper#sheet_data_for_bid, BidsGroup#get_bid_additional_requests, Api::V1::TradeController#generate_bids_group_for_trade_requests, TradeRequest#currency_configuration, User#can_view_bid?, TradeRequestModelHelper#event_masking_enabled? / mask_participant_name?, TradeControllerHelper#tabs_summary / set_pagination_for_line_items / get_counter_offer_additional_requests / is_allowed_to_close_bid, Bid#is_surrogate_bid?, BaseSerializer#serializable_hash.
- Tables/models touched (reads): trade_requests, template_responses, proposals, users, companies; via helpers bids, bids_groups, additional_requests. No writes visible in the lines read.
- Known defects on path: none of the 3 recorded defects.
- Where it becomes uncertain: (a) body past :700 unread; (b) RUNTIME edges cover only test-exercised branches; (c) orders/api.js:79 builds the URL with `let` -- the base resolves, any appended query string is runtime.

## C2 — a third Session token_type
- Enum: `token_type { sourcing: 0, mcp: 1 }` (app/models/session.rb:33). Every guard tests `mcp?` specifically, never "is this a non-web token", so a new value like `code_graph` is treated as an ordinary WEB session everywhere.
- Guards inside Session and what each protects:
  - `generate_access_token` (:57, `return if self.mcp?` :58): mcp keeps the Clara-issued token; any other type gets a fresh random token. code_graph -> gets a token (fine).
  - `disable_same_device_sessions` (after_save_commit :36; def :67, guard :68): when an active session's login_count/created_at changed, marks every OTHER `Session.not_mcp` on the same `device_identifier` in_active (:71-73). code_graph -> **logs the user out of the dashboard on that device**.
  - `enforce_single_web_session` (after_create_commit :37; def :78, `return unless Rails.env.production?`, guard :80): unless `multiple_sessions_allowed?` (mobile/cli api_client) or `user.can_login_on_multiple_devices?`, invalidates all other `user.active_web_sessions`. code_graph -> **in production, kills every other web session**.
  - `update_company_profile` (after_create_commit :31; guard :98): skipped for mcp; code_graph would run it.
  - `send_email_notification` (after_save_commit :36; guard :110): skipped for mcp; code_graph would **send a new-login email**.
  - `update_session_end_time` (guard :126): mcp has no expiry; code_graph would get a session_end_time.
  - `Session.invalidate_sessions` uses `Session.active.not_mcp` (:50): code_graph sessions are invalidatable like web ones.
- Guards outside Session:
  - `json_helpers.rb:33 check_session_validity`: mcp sessions are not deactivated on a 401; code_graph would be.
  - `lib/modules/login_signup_helper.rb:343` (session-expiry check) and `:352 validate_session_inactivity`: mcp is exempt from expiry/inactivity; code_graph would expire.
  - `app/models/application_record.rb:242 mcp_client?` -> `mcp_client_data`: only mcp gets MCP client metadata.
  - Listings/invalidation exclude mcp: `user.rb:237`, `api/session_controller.rb:37`, `helpers/users_helper.rb:29` (`not_mcp`).
- Also `Clara::Auth#execute!` hardcodes `token_type = "mcp"` (clara/auth.rb:19).
- Consequence in one line: adding code_graph without touching the guards means minting one **logs the user out** (same device always; all devices in production) and emails them. Fix: replace `return if self.mcp?` with `return unless self.sourcing?` (or add a `web?` predicate) and turn `not_mcp` into a `web` scope.
