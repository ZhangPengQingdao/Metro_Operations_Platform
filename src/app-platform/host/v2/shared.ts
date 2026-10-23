import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import * as AppSdk from '@metro/platform-sdk/app';
import * as UiKit from '../../../components/ui/app-exports';

/**
 * Modules a v2 page bundle reads from the shell (`mop-app build` compiles these imports into registry lookups).
 * Pages therefore share the shell's single React instance, UI kit and AppRuntimeProvider context.
 */
export function installSharedModules() {
  const target = globalThis as typeof globalThis & { __MOP_SHARED__?: Readonly<Record<string, unknown>> };
  target.__MOP_SHARED__ ??= Object.freeze({
    react: React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient, 'react/jsx-runtime': JSXRuntime,
    '@metro/platform-sdk/app': AppSdk, '@metro/platform-sdk/ui': UiKit,
  });
}
