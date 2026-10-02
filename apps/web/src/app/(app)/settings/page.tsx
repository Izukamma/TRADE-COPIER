import { requireOwnerPage } from "@/lib/authz";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { Card, PageHead, Badge } from "@/components/ui";
import { TwoFactorSetup } from "./two-factor";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireOwnerPage();
  const s = await auth().api.getSession({ headers: await headers() });
  const enabled = !!(s?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled;
  return (
    <>
      <PageHead title="Settings" sub="Owner security." />
      <Card title={<>Two-factor authentication {enabled ? <Badge tone="ok">ENABLED</Badge> : <Badge tone="warn">NOT ENABLED</Badge>}</>}>
        <TwoFactorSetup enabled={enabled} />
      </Card>
    </>
  );
}
