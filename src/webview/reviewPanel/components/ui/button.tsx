import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva("button", {
	variants: {
		variant: {
			default: "button--default",
			secondary: "button--secondary",
			ghost: "button--ghost",
			destructive: "button--destructive"
		},
		size: {
			default: "button--default-size",
			sm: "button--sm",
			icon: "button--icon"
		}
	},
	defaultVariants: {
		variant: "default",
		size: "default"
	}
});

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, ...props }, ref) => (
		<button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
	)
);

Button.displayName = "Button";
