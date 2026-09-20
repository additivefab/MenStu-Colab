import type { Metadata } from "next";
import ActivateAccount from "./activate-account";

export const metadata: Metadata = { title: "设置密码｜探研", referrer: "no-referrer", robots: { index: false, follow: false } };
export default function ActivatePage() { return <ActivateAccount />; }
