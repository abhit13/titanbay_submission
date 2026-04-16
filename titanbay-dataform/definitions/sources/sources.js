// Declares all raw source tables so Dataform can reference them
// without owning them. Raw tables live in the 'raw' dataset and are
// loaded by upstream ingestion pipelines (Freshdesk export + warehouse sync).

declare({ database: "titanbay-prod", schema: "raw", name: "raw_freshdesk_tickets" });
declare({ database: "titanbay-prod", schema: "raw", name: "raw_platform_investors" });
declare({ database: "titanbay-prod", schema: "raw", name: "raw_platform_entities" });
declare({ database: "titanbay-prod", schema: "raw", name: "raw_platform_partners" });
declare({ database: "titanbay-prod", schema: "raw", name: "raw_platform_relationship_managers" });
declare({ database: "titanbay-prod", schema: "raw", name: "raw_platform_fund_closes" });
