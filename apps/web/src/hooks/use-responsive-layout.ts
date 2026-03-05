/**
 * Responsive layout hook for the panel system.
 *
 * Provides viewport-aware sizing values for the sidebar and panel system
 * to ensure the layout works well from 1080p to 5K displays.
 *
 * At 1080p (1920px):
 * - Sidebar: 220px min, 280px default, 90% max
 * - Pane minimum: ~100px (usable terminal with ~12 columns)
 *
 * At 1440p (2560px):
 * - Sidebar: 240px min, 320px default, 90% max
 *
 * At 4K (3840px):
 * - Sidebar: 280px min, 400px default, 90% max
 *
 * At 5K (5120px):
 * - Sidebar: 300px min, 440px default, 90% max
 *
 * Pixel values are converted to percentages because react-resizable-panels
 * uses percentage-based sizing.
 *
 * @see Issue #81: Panel responsive layout
 */

import { useCallback, useEffect, useState } from "react";

/** The minimum usable width for a terminal pane in pixels. */
const MIN_PANE_WIDTH_PX = 100;

/** Sidebar sizing breakpoints (in viewport width pixels). */
const SIDEBAR_CONFIG = {
	/** Minimum sidebar width in pixels. */
	minPx: 220,
	/** Maximum sidebar width in pixels. */
	maxPx: 480,
	/** Default sidebar width in pixels. */
	defaultPx: 280,
	/** Additional pixels per 1000px of viewport width beyond 1920px. */
	scalePerKPx: 50,
} as const;

interface ResponsiveLayoutSizes {
	/** Whether the viewport is narrow enough to support sidebar collapsing. */
	readonly canCollapseSidebar: boolean;
	/** Minimum pane size as a percentage string (e.g., "5%"). */
	readonly paneMin: string;
	/** Sidebar default size as a percentage string (e.g., "25%"). */
	readonly sidebarDefault: string;
	/** Sidebar maximum size as a percentage string (e.g., "35%"). */
	readonly sidebarMax: string;
	/** Sidebar minimum size as a percentage string (e.g., "12%"). */
	readonly sidebarMin: string;
	/** Current viewport width in pixels. */
	readonly viewportWidth: number;
}

/**
 * Clamp a value between a minimum and maximum.
 */
function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Convert a pixel value to a percentage of the viewport width,
 * formatted as a string with "%" suffix for react-resizable-panels.
 */
function pxToPercent(px: number, viewportWidth: number): string {
	const percent = (px / viewportWidth) * 100;
	return `${Math.round(percent)}%`;
}

/**
 * Compute sidebar pixel values based on viewport width.
 * Sidebar grows slightly on larger displays to take advantage of space.
 */
function computeSidebarPx(viewportWidth: number): {
	defaultPx: number;
	minPx: number;
} {
	const extraKPx = Math.max(0, viewportWidth - 1920) / 1000;
	const scale = extraKPx * SIDEBAR_CONFIG.scalePerKPx;

	return {
		defaultPx: clamp(
			SIDEBAR_CONFIG.defaultPx + scale,
			SIDEBAR_CONFIG.minPx,
			SIDEBAR_CONFIG.maxPx
		),
		minPx: clamp(
			SIDEBAR_CONFIG.minPx + scale * 0.4,
			SIDEBAR_CONFIG.minPx,
			SIDEBAR_CONFIG.maxPx
		),
	};
}

/**
 * Returns responsive sizing values for the panel system based on the
 * current viewport width. Values update on window resize.
 *
 * Uses `matchMedia` listeners for efficiency rather than polling or
 * continuous resize event listeners.
 */
function useResponsiveLayout(): ResponsiveLayoutSizes {
	const computeSizes = useCallback((): ResponsiveLayoutSizes => {
		const vw = window.innerWidth;
		const sidebar = computeSidebarPx(vw);

		// Minimum pane size: ensure at least MIN_PANE_WIDTH_PX, but cap at 15%
		// to prevent one pane from dominating in deeply nested splits.
		const paneMinPercent = clamp((MIN_PANE_WIDTH_PX / vw) * 100, 3, 15);

		return {
			sidebarDefault: pxToPercent(sidebar.defaultPx, vw),
			sidebarMin: pxToPercent(sidebar.minPx, vw),
			sidebarMax: "90%",
			paneMin: `${Math.round(paneMinPercent)}%`,
			canCollapseSidebar: vw < 1280,
			viewportWidth: vw,
		};
	}, []);

	const [sizes, setSizes] = useState<ResponsiveLayoutSizes>(computeSizes);

	useEffect(() => {
		const handleResize = () => {
			setSizes(computeSizes());
		};

		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [computeSizes]);

	return sizes;
}

export { useResponsiveLayout, MIN_PANE_WIDTH_PX };
export type { ResponsiveLayoutSizes };
