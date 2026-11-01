import { ControlRoom } from "@/components/control-room";
import { demoRun } from "@/lib/demo-data";

export default function Page() {
  return <ControlRoom initialRun={demoRun} />;
}
