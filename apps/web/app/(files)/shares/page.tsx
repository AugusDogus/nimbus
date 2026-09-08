import { redirect } from "next/navigation";

export default function Page() {
  redirect("/shared?tab=links");
}
