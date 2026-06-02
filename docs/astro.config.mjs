// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://drew-simmons.github.io',
	base: '/skrvm',
	integrations: [
		starlight({
			title: 'Skrvm Orchestrator',
			tagline: 'State-of-the-art desktop coding agent orchestrator',
			logo: {
				src: './src/assets/logo.png',
			},
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/drew-simmons/skrvm' }
			],
			editLink: {
				baseUrl: 'https://github.com/drew-simmons/skrvm/edit/main/docs/',
			},
			customCss: [
				'./src/content/docs/custom.css'
			],
			sidebar: [
				{
					label: 'Getting Started',
					slug: 'guides/getting-started',
				},
				{
					label: 'Core Guides',
					items: [
						{ label: 'Configuration Guide', slug: 'guides/configuration' },
						{ label: 'System Architecture', slug: 'guides/architecture' },
						{ label: 'Integrations & Trackers', slug: 'guides/integrations' },
						{ label: 'Coding Agents Protocol', slug: 'guides/protocol' },
					]
				},
				{
					label: 'Operations & Development',
					items: [
						{ label: 'Operator Guide', slug: 'guides/operator-guide' },
						{ label: 'Developer & Contributor Guide', slug: 'guides/developer-guide' },
					]
				}
			],
		}),
	],
});
