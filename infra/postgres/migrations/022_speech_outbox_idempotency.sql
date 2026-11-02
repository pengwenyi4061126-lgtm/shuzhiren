create unique index if not exists outbox_events_tenant_speech_command_id_idx
  on outbox_events (tenant_id, event_type, ((payload #>> '{command,id}')))
  where event_type = 'speech.dispatch';
