"use client";

import { Layers3, LoaderCircle, Plus, Save, ShieldCheck, UserRoundCog } from "lucide-react";
import { useState } from "react";
import { clientFetch as fetch } from "@/lib/client-request";
import type { ChannelConnection } from "@/lib/channels";
import type { ActorRole, MembershipAccessScope } from "@/lib/control-plane/auth-context";
import type { StoredRun } from "@/lib/control-plane/store";
import type { MembershipResourceScope, MembershipStatus, TenantMembership } from "@/lib/memberships";

type Props = { initialMemberships: TenantMembership[]; channels: ChannelConnection[]; runs: StoredRun[] };
const roles: ActorRole[] = ["admin", "operator", "reviewer", "analyst"];
const statuses: MembershipStatus[] = ["active", "suspended", "revoked"];
const labels: Record<ActorRole | MembershipStatus | MembershipAccessScope, string> = {
  admin: "管理员", operator: "运营", reviewer: "审核", analyst: "分析",
  active: "有效", suspended: "已暂停", revoked: "已撤销",
  tenant: "全租户", restricted: "受限范围"
};

export function MembershipWorkspace({ initialMemberships, channels, runs }: Props) {
  const [memberships, setMemberships] = useState(initialMemberships);
  const [subject, setSubject] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<ActorRole>("operator");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function addMembership(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("create"); setError(null);
    try {
      const response = await fetch("/api/v1/memberships", { method: "POST", body: JSON.stringify({ externalSubject: subject, displayName, role }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "成员创建失败");
      setMemberships((current) => [...current, payload.data].sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN")));
      setSubject(""); setDisplayName(""); setRole("operator");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "成员创建失败"); }
    finally { setPending(null); }
  }

  async function updateMembership(member: TenantMembership, update: { role?: ActorRole; status?: MembershipStatus; accessScope?: MembershipAccessScope; resourceScopes?: MembershipResourceScope[] }) {
    setPending(member.id); setError(null);
    try {
      const response = await fetch(`/api/v1/memberships/${member.id}`, { method: "PUT", body: JSON.stringify(update) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "成员更新失败");
      setMemberships((current) => current.map((item) => item.id === member.id ? payload.data : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "成员更新失败"); }
    finally { setPending(null); }
  }

  function toggleScope(member: TenantMembership, scope: MembershipResourceScope, selected: boolean) {
    const scopes = selected
      ? [...member.resourceScopes, scope]
      : member.resourceScopes.filter((item) => item.resourceType !== scope.resourceType || item.resourceId !== scope.resourceId);
    void updateMembership(member, { accessScope: "restricted", resourceScopes: scopes });
  }

  return <section className="membership-grid">
    <article className="membership-panel"><header><div><UserRoundCog size={18} /><div><h2>新增成员</h2><span>OIDC subject 必须与身份提供商签发的 `sub` 完全一致。</span></div></div></header>
      <form onSubmit={addMembership}>
        <label>OIDC Subject<input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={500} required /></label>
        <label>显示名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={200} required /></label>
        <label>初始角色<select value={role} onChange={(event) => setRole(event.target.value as ActorRole)}>{roles.map((item) => <option value={item} key={item}>{labels[item]}</option>)}</select></label>
        <button type="submit" disabled={pending !== null}>{pending === "create" ? <LoaderCircle className="button-spinner" size={16} /> : <Plus size={16} />}添加成员</button>
      </form>
    </article>
    <article className="membership-panel membership-directory"><header><div><ShieldCheck size={18} /><div><h2>成员与授权</h2><span>管理员始终全租户访问；受限成员仅可使用下方选中的频道与场次，暂停和撤销会在下一请求生效。</span></div></div><b>{memberships.length} 人</b></header>
      {error ? <p className="membership-error">{error}</p> : null}
      <div className="membership-table" aria-label="租户成员"><div className="membership-row membership-labels"><span>成员</span><span>角色</span><span>访问范围</span><span>状态</span><span>更新时间</span><span>操作</span></div>{memberships.map((member) => <article className="membership-row" key={member.id}><div><strong>{member.displayName}</strong><small>{member.externalSubject}</small></div><select aria-label={`${member.displayName} 的角色`} disabled={pending !== null} value={member.role} onChange={(event) => updateMembership(member, { role: event.target.value as ActorRole })}>{roles.map((item) => <option value={item} key={item}>{labels[item]}</option>)}</select><select aria-label={`${member.displayName} 的访问范围`} disabled={pending !== null || member.role === "admin"} value={member.accessScope} onChange={(event) => updateMembership(member, { accessScope: event.target.value as MembershipAccessScope })}>{(["tenant", "restricted"] as MembershipAccessScope[]).map((item) => <option value={item} key={item}>{labels[item]}</option>)}</select><select aria-label={`${member.displayName} 的状态`} disabled={pending !== null} value={member.status} onChange={(event) => updateMembership(member, { status: event.target.value as MembershipStatus })}>{statuses.map((item) => <option value={item} key={item}>{labels[item]}</option>)}</select><time dateTime={member.updatedAt}>{new Date(member.updatedAt).toLocaleString("zh-CN")}</time><span>{pending === member.id ? <LoaderCircle className="button-spinner" size={16} /> : <Save size={16} aria-label="变更已保存" />}</span>{member.accessScope === "restricted" ? <ScopePicker member={member} channels={channels} runs={runs} disabled={pending !== null} onToggle={toggleScope} /> : null}</article>)}</div>
    </article>
  </section>;
}

function ScopePicker({ member, channels, runs, disabled, onToggle }: { member: TenantMembership; channels: ChannelConnection[]; runs: StoredRun[]; disabled: boolean; onToggle: (member: TenantMembership, scope: MembershipResourceScope, selected: boolean) => void }) {
  const selected = new Set(member.resourceScopes.map((scope) => `${scope.resourceType}:${scope.resourceId}`));
  return <div className="membership-scope-picker"><div><Layers3 size={14} /><strong>已授权资源</strong></div><fieldset disabled={disabled}><legend>频道</legend>{channels.map((channel) => <label key={channel.id}><input type="checkbox" checked={selected.has(`channel_connection:${channel.id}`)} onChange={(event) => onToggle(member, { resourceType: "channel_connection", resourceId: channel.id }, event.target.checked)} />{channel.name}</label>)}</fieldset><fieldset disabled={disabled}><legend>场次</legend>{runs.map((run) => <label key={run.id}><input type="checkbox" checked={selected.has(`live_run:${run.id}`)} onChange={(event) => onToggle(member, { resourceType: "live_run", resourceId: run.id }, event.target.checked)} />{run.showName}</label>)}</fieldset></div>;
}
