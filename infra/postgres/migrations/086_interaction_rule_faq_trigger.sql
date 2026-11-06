-- Knowledge base answering (P1): interaction rules get a fourth kind of trigger, "faq", which answers a viewer
-- question from the tenant's approved knowledge entries (087). A new enum value cannot be used in the
-- transaction that adds it, and the Migrator runs one transaction per file, so the constraints in 087 that name
-- 'faq' live in the next migration.
alter type interaction_rule_trigger add value 'faq';
