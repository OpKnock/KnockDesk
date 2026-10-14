// Stub pages - to be implemented with v2 design system
const createStubPage = (title: string, description: string, icon: string) => () => (
  <div style={{ border: '1px solid var(--kd-color-border-default)', borderRadius: '12px', padding: '24px', background: 'var(--kd-color-bg-secondary)', textAlign: 'center', maxWidth: '600px', margin: '0 auto' }}>
    <div style={{ fontSize: '48px', marginBottom: '16px' }}>{icon}</div>
    <h2 style={{ margin: '0 0 8px 0', fontSize: '20px', fontWeight: 600 }}>{title}</h2>
    <p style={{ margin: 0, color: 'var(--kd-color-fg-muted)' }}>{description}</p>
    <div style={{ marginTop: '24px' }}>
      <span style={{ fontSize: '13px', color: 'var(--kd-color-fg-muted)' }}>Coming soon with v2 design system</span>
    </div>
  </div>
);

export const SessionsPage = createStubPage('Sessions', 'Manage conversation history and session analytics', '💬');
export const SkillsPage = createStubPage('Skills', 'Manage and configure agent skills', '🎯');
export const ChannelsPage = createStubPage('Channels', 'Configure messaging channels and integrations', '📡');
export const CronPage = createStubPage('Cron', 'Schedule and manage automated tasks', '⏰');
export const AnalyticsPage = createStubPage('Analytics', 'View usage analytics and insights', '📊');
export const PluginsPage = createStubPage('Plugins', 'Manage and install plugins', '🧩');
export const ProfilesPage = createStubPage('Profiles', 'Manage agent profiles and personas', '👤');
export const ProfileBuilderPage = createStubPage('Profile Builder', 'Create and customize agent profiles', '🔧');
export const EnvPage = createStubPage('Environment', 'Manage environment variables and secrets', '🔐');
export const FilesPage = createStubPage('Files', 'Manage uploaded files and documents', '📁');
export const LogsPage = createStubPage('Logs', 'View system logs and diagnostics', '📋');
export const McpPage = createStubPage('MCP', 'Manage Model Context Protocol servers', '🔌');
export const PairingPage = createStubPage('Pairing', 'Pair devices and manage connections', '🔗');
export const SystemPage = createStubPage('System', 'System settings and diagnostics', '⚙️');
export const WebhooksPage = createStubPage('Webhooks', 'Configure webhook endpoints', '🔗');
export const DocsPage = createStubPage('Documentation', 'View documentation and guides', '📚');
export const AnalyticsPage2 = createStubPage('Analytics', 'View usage analytics and insights', '📊');