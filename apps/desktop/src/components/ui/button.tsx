import * as React from "react";
import { Slot as SlotPrimitive } from "radix-ui";
import {
  Button as PanelButton,
  buttonVariants as panelButtonVariants,
  type ButtonVariant,
  type ButtonSize as PanelSize,
} from "../panelui/button";
import { cn } from "@/lib/utils";

type Size =
  | "default"
  | "xs"
  | "sm"
  | "lg"
  | "icon"
  | "icon-xs"
  | "icon-sm"
  | "icon-lg";
const panelSize = (size: Size): PanelSize =>
  size === "default"
    ? "md"
    : size === "xs"
      ? "sm"
      : size === "icon-xs"
        ? "icon-sm"
        : size;
const compact = (size: Size) =>
  size === "xs"
    ? "h-6 px-2 text-xs"
    : size === "icon-xs"
      ? "size-6"
      : undefined;
function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: {
  variant?: ButtonVariant;
  size?: Size;
  className?: string;
} = {}) {
  return panelButtonVariants({
    variant,
    size: panelSize(size),
    className: cn(compact(size), className),
  });
}
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: Size;
  asChild?: boolean;
  loading?: boolean;
}) {
  if (asChild)
    return (
      <SlotPrimitive.Slot
        data-slot="button"
        className={buttonVariants({ variant, size, className })}
        {...props}
      />
    );
  return (
    <PanelButton
      variant={variant}
      size={panelSize(size)}
      loading={loading}
      className={cn(compact(size), className)}
      {...props}
    />
  );
}
export { Button, buttonVariants };
