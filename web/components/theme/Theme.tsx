/* eslint-disable react/no-danger */
import Head from 'next/head';
import { FC, useEffect, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { ClientConfig } from '../../interfaces/client-config.model';
import { clientConfigStateAtom } from '../stores/ClientConfigStore';

export const Theme: FC = () => {
  const clientConfig = useRecoilValue<ClientConfig>(clientConfigStateAtom);
  const { appearanceVariables, customStyles } = clientConfig;

  const appearanceEntries: Array<[string, string]> =
    appearanceVariables instanceof Map
      ? Array.from(appearanceVariables.entries())
      : Object.entries((appearanceVariables || {}) as Record<string, string>);
  const appearanceMap = new Map(appearanceEntries);
  const getAppearanceVariable = (variable: string) => appearanceMap.get(variable);
  const accent =
    getAppearanceVariable('oc-accent') || getAppearanceVariable('theme-color-action') || '#d246d2';
  const accentSoft = (() => {
    const customAccent = getAppearanceVariable('oc-accent-soft');
    if (customAccent) return customAccent;

    const color = accent.trim();
    if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}29`;
    if (/^#[0-9a-f]{3}$/i.test(color)) {
      const expanded = color
        .slice(1)
        .split('')
        .map(channel => `${channel}${channel}`)
        .join('');
      return `#${expanded}29`;
    }
    return 'rgba(210, 70, 210, 0.16)';
  })();

  const userThemeVariables: Record<string, string> = {
    'oc-surface-page':
      getAppearanceVariable('oc-surface-page') ||
      getAppearanceVariable('theme-color-background-main') ||
      '#1b1b1f',
    'oc-surface-header':
      getAppearanceVariable('oc-surface-header') ||
      getAppearanceVariable('theme-color-background-header') ||
      '#101014',
    'oc-surface-chat':
      getAppearanceVariable('oc-surface-chat') ||
      getAppearanceVariable('theme-color-components-chat-background') ||
      '#101114',
    'oc-surface-elevated':
      getAppearanceVariable('oc-surface-elevated') ||
      getAppearanceVariable('theme-color-components-menu-background') ||
      '#202027',
    'oc-text-primary':
      getAppearanceVariable('oc-text-primary') ||
      getAppearanceVariable('theme-color-components-text-on-dark') ||
      '#ececf2',
    'oc-text-secondary':
      getAppearanceVariable('oc-text-secondary') ||
      getAppearanceVariable('theme-color-components-chat-text') ||
      getAppearanceVariable('theme-color-components-video-status-bar-foreground') ||
      '#c9c9d1',
    'oc-text-on-accent':
      getAppearanceVariable('oc-text-on-accent') ||
      getAppearanceVariable('theme-color-components-primary-button-text') ||
      '#fff',
    'oc-accent': accent,
    'oc-accent-hover':
      getAppearanceVariable('oc-accent-hover') ||
      getAppearanceVariable('theme-color-action-hover') ||
      '#e178e1',
    'oc-accent-soft': accentSoft,
    'oc-control-radius':
      getAppearanceVariable('oc-control-radius') ||
      getAppearanceVariable('theme-rounded-corners') ||
      '10px',
  };

  const appearanceVars = [
    ...appearanceEntries
      .filter(([, value]) => !!value)
      .map(([variable, value]) => `--${variable}: ${value}`),
    ...Object.entries(userThemeVariables).map(([variable, value]) => `--${variable}: ${value}`),
  ];

  const [themeColor, setThemeColor] = useState('#fff');

  useEffect(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue(
      '--theme-color-background-header',
    );
    setThemeColor(color);
  }, [appearanceVars]);

  return (
    <>
      <Head>
        <meta name="theme-color" content={themeColor} />
      </Head>
      <style
        dangerouslySetInnerHTML={{
          __html: `
				:root {
					${appearanceVars.join(';\n')}
				}
			`,
        }}
      />
      <style
        dangerouslySetInnerHTML={{
          __html: `
				${customStyles}
			`,
        }}
      />
    </>
  );
};
