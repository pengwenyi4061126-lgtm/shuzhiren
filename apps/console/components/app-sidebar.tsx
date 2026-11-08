"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Archive, BarChart3, BookOpenCheck, CalendarDays, ChartNoAxesCombined, Clapperboard, FileText, Gauge, LifeBuoy, Package, PackageCheck, Radio, Send, ShieldAlert, ShieldCheck, SquareStack, Users, UsersRound, Zap, MonitorPlay, Images } from "lucide-react";

const groups = [
  {
    label: "直播工作台",
    items: [
      { href: "/", label: "直播指挥台", icon: MonitorPlay },
      { href: "/shows", label: "场次排期", icon: CalendarDays }
    ]
  },
  {
    label: "内容资产",
    items: [
      { href: "/studio", label: "内容工坊", icon: Clapperboard },
      { href: "/assets", label: "素材资产", icon: Images },
      { href: "/products", label: "商品中心", icon: Package },
      { href: "/releases", label: "发布治理", icon: PackageCheck },
      { href: "/knowledge", label: "知识库", icon: BookOpenCheck }
    ]
  },
  {
    label: "安全与协作",
    items: [
      { href: "/policy", label: "知识与策略", icon: ShieldCheck },
      { href: "/interaction-rules", label: "互动规则", icon: Zap },
      { href: "/prohibited-terms", label: "违禁词库", icon: ShieldAlert },
      { href: "/channels", label: "渠道设置", icon: SquareStack },
      { href: "/memberships", label: "人员权限", icon: UsersRound }
    ]
  },
  {
    label: "运行值守",
    items: [
      { href: "/monitoring", label: "运行监控", icon: ChartNoAxesCombined },
      { href: "/incidents", label: "异常事件", icon: LifeBuoy },
      { href: "/outbox", label: "投递队列", icon: Send },
      { href: "/runbooks", label: "运行手册", icon: BookOpenCheck },
      { href: "/recordings", label: "录制归档", icon: Archive }
    ]
  },
  {
    label: "经营与审计",
    items: [
      { href: "/analytics", label: "经营数据", icon: BarChart3 },
      { href: "/settlements", label: "结算对账", icon: FileText },
      { href: "/usage", label: "商业额度", icon: Gauge },
      { href: "/audit", label: "审计中心", icon: FileText }
    ]
  }
];

function isCurrentPath(pathname: string, href: string) {
  return href === "/" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="app-sidebar">
      <Link className="app-brand" href="/" aria-label="Shuzhiren Studio 首页">
        <span className="app-brand-mark"><Radio size={17} /></span>
        <span><strong>Shuzhiren</strong><small>LIVE OPERATIONS</small></span>
      </Link>
      <nav className="app-nav" aria-label="工作区">
        {groups.map((group) => (
          <section className="app-nav-group" key={group.label}>
            <h2>{group.label}</h2>
            {group.items.map(({ href, label, icon: Icon }) => {
              const active = isCurrentPath(pathname, href);
              return <Link aria-current={active ? "page" : undefined} className={active ? "app-nav-item active" : "app-nav-item"} href={href} key={href}><Icon size={17} strokeWidth={1.8} /><span>{label}</span></Link>;
            })}
          </section>
        ))}
      </nav>
      <div className="app-sidebar-footer">
        <span className="app-user-mark"><Users size={15} /></span>
        <span><strong>运营组</strong><small>华东直播间</small></span>
        <span className="app-online-dot" aria-label="工作区在线" />
      </div>
    </aside>
  );
}
