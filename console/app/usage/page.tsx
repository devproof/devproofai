import { redirect } from "next/navigation";

// The combined usage page split into Usage — API and Usage — Sessions
// (2026-07-14); old links land on the API page.
export default function UsagePage() {
  redirect("/usage/api");
}
