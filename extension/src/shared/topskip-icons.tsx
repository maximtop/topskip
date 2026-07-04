import type { ReactElement } from 'react';

/**
 * Common dimensions and color accepted by local SVG icons.
 */
export type TopSkipIconProps = {
    size: number;
    color?: string;
};

/**
 * Product mark used by popup and options branding.
 *
 * @param props - SVG dimensions and optional color.
 * @returns TopSkip skip/play mark.
 */
export function TopSkipLogoIcon(props: TopSkipIconProps): ReactElement {
    const color = props.color ?? '#2563EB';
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 162 162"
            fill="none"
            aria-hidden="true"
        >
            <path
                d="M25 21L65 50V112L25 141C13 150 3 141 3 125V37C3 21 13 12 25 21Z"
                fill={color}
            />
            <path
                d="M87 20.5944L151 68.9189C163 77.9797 163 84.0203 151 93.0811L87 141.406C75 150.466 65 141.406 65 125.297V112.21L98 89.0541C103 85.027 103 76.973 98 72.9459L65 49.7904V36.7025C65 20.5944 75 11.5335 87 20.5944Z"
                fill={color}
            />
        </svg>
    );
}

/**
 * Compact check mark for positive statuses.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Check icon.
 */
export function CheckIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M20 6 9 17l-5-5" />
        </svg>
    );
}

/**
 * Settings gear matching the reference outline style.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Settings icon.
 */
export function SettingsIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.27 7.27 0 0 0-1.69-.98L14.5 2.42A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42L9.13 5.07c-.6.24-1.16.57-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.02.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.38.31.61.22l2.49-1c.53.41 1.09.74 1.69.98l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.6-.24 1.16-.57 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65Z" />
        </svg>
    );
}

/**
 * Home icon for the General options section.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Home icon.
 */
export function HomeIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m3 11 9-8 9 8" />
            <path d="M5 10v10h14V10" />
            <path d="M9 20v-6h6v6" />
        </svg>
    );
}

/**
 * Target icon for detection settings.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Target icon.
 */
export function TargetIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3" />
            <path d="M12 19v3" />
            <path d="M2 12h3" />
            <path d="M19 12h3" />
        </svg>
    );
}

/**
 * Palette icon for appearance settings.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Palette icon.
 */
export function PaletteIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 0-4H13a2 2 0 0 1 0-4h1a7 7 0 0 0 0-10h-2Z" />
            <path d="M7.5 10h.01" />
            <path d="M9.5 6.5h.01" />
            <path d="M14.5 6.5h.01" />
        </svg>
    );
}

/**
 * Keyboard icon for shortcuts settings.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Keyboard icon.
 */
export function KeyboardIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 9h.01" />
            <path d="M11 9h.01" />
            <path d="M15 9h.01" />
            <path d="M7 13h10" />
        </svg>
    );
}

/**
 * Info icon used for About and helper callouts.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Info icon.
 */
export function InfoIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 17v-5" />
            <path d="M12 8h.01" />
        </svg>
    );
}

/**
 * Pencil icon for edit actions.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Edit icon.
 */
export function PencilIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
    );
}

/**
 * Trash icon for delete actions.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Delete icon.
 */
export function TrashIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="m19 6-1 14H6L5 6" />
            <path d="M10 11v5" />
            <path d="M14 11v5" />
        </svg>
    );
}

/**
 * X icon for cancel actions.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Cancel icon.
 */
export function XIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        </svg>
    );
}

/**
 * External-link icon for navigation actions.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns External-link icon.
 */
export function ExternalLinkIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
            <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
        </svg>
    );
}

/**
 * Lock icon for local-key storage helper text.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Lock icon.
 */
export function LockIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
    );
}

/**
 * Small promo block icon for popup detection summary.
 *
 * @param props - SVG dimensions and optional stroke color.
 * @returns Promo block icon.
 */
export function PromoBlocksIcon(props: TopSkipIconProps): ReactElement {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={props.size}
            height={props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={props.color ?? 'currentColor'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="5" y="7" width="14" height="11" rx="2" />
            <path d="M9 7V4" />
            <path d="M15 7V4" />
            <path d="M9 13h.01" />
            <path d="M15 13h.01" />
            <path d="M10 18v2" />
            <path d="M14 18v2" />
        </svg>
    );
}
