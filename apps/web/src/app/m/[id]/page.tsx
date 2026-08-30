import { ControlCenter } from "@/components/control-center";

export default async function MigrationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ControlCenter migrationId={id} />;
}
