import { cn } from "@/lib/utils";

export function NimbusWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-wordmark text-xl font-medium leading-none",
        className,
      )}
    >
      Nimbus
    </span>
  );
}
