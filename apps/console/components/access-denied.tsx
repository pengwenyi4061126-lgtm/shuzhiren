import Link from "next/link";
import { ShieldX } from "lucide-react";

export function AccessDenied() {
  return <main className="empty-page access-denied">
    <ShieldX size={28} aria-hidden="true" />
    <h1>无权访问此工作区</h1>
    <p>当前账号角色不具备查看这项运营数据的权限。</p>
    <Link href="/">返回指挥台</Link>
  </main>;
}
