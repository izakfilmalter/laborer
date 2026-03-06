"use client";

import type { Button as ButtonPrimitive } from "@base-ui/react/button";
import type { VariantProps } from "class-variance-authority";
import { Boolean, pipe } from "effect";
import { CheckIcon, ClipboardIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, type buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CopyButtonProps
	extends ButtonPrimitive.Props,
		VariantProps<typeof buttonVariants> {
	value: string;
}

export async function copyToClipboardWithMeta(value: string): Promise<void> {
	await navigator.clipboard.writeText(value);
}

export function CopyButton({
	value,
	className,
	variant = "ghost",
	...props
}: CopyButtonProps) {
	const [hasCopied, setHasCopied] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset after 2s timeout on any copy
	useEffect(() => {
		const timeout = setTimeout(() => {
			setHasCopied(false);
		}, 2000);

		return () => {
			clearTimeout(timeout);
		};
	}, [hasCopied]);

	return (
		<Button
			className={cn("relative z-10", className)}
			onClick={() => {
				copyToClipboardWithMeta(value).then(() => {
					setHasCopied(true);
				});
			}}
			size="icon-xs"
			variant={variant}
			{...props}
		>
			<span className="sr-only">Copy</span>
			{pipe(
				hasCopied,
				Boolean.match({
					onFalse: () => <ClipboardIcon />,
					onTrue: () => <CheckIcon />,
				})
			)}
		</Button>
	);
}
