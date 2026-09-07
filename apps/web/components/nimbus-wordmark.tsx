import { Fredoka } from "next/font/google";

import { cn } from "@/lib/utils";

const fredoka = Fredoka({
  subsets: ["latin"],
  weight: "500",
  display: "swap",
});

export function NimbusWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        fredoka.className,
        "text-xl font-medium leading-none",
        className,
      )}
    >
      Nimbus
    </span>
  );
}
