import React from 'react';

export const COMMUNITY_URL = 'https://github.com/Ternlux/releases/discussions';
const GITHUB_INK = '#24292f';

export const GitHubLogo = ({ size = 18, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={color} aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

// "Join the community" link to GitHub Discussions. Electron's setWindowOpenHandler routes
// target="_blank" links to the system browser, so a plain anchor is enough.
// This is a community link, NOT a sign-in method — the copy says so, and the
// card variant keeps it visually apart from the auth buttons.
//   variant="card"    — explained community card (sign-in / register / account)
//   variant="compact" — subtle row for the Settings sidebar footer
const COMMUNITY_TOPICS = [
  'News on new feature releases',
  'Questions about using the app',
  'Suggestions for product features',
  'Workflows and tips from other Ternlux users',
];

const hoverHandlers = (on, off) => ({
  onMouseOver: e => Object.assign(e.currentTarget.style, on),
  onMouseOut: e => Object.assign(e.currentTarget.style, off),
});

const CommunityLink = ({ variant = 'card', style }) => {
  if (variant === 'compact') {
    return (
      <a
        href={COMMUNITY_URL}
        target="_blank"
        rel="noopener noreferrer"
        title="Join the Ternlux community on GitHub Discussions for release news, questions and feature suggestions"
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px', borderRadius: 6, textDecoration: 'none',
          transition: 'background 0.15s', ...style,
        }}
        {...hoverHandlers({ background: 'rgba(36,41,47,0.06)' }, { background: 'transparent' })}
      >
        <GitHubLogo size={20} color={GITHUB_INK} />
        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#262626' }}>Join the community</span>
          <span style={{ fontSize: 11, color: '#8c8c8c' }}>News, help &amp; ideas on GitHub</span>
        </span>
      </a>
    );
  }

  return (
    <div
      style={{
        textAlign: 'left', border: '1px solid #d0d7de', background: '#f6f8fa',
        borderRadius: 10, padding: 16, ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <GitHubLogo size={22} color={GITHUB_INK} />
        <span style={{ fontSize: 14, fontWeight: 700, color: '#262626' }}>
          Join the Ternlux community
        </span>
      </div>
      <div style={{ fontSize: 13, color: '#595959', marginBottom: 6 }}>
        Our GitHub Discussions board is where we share:
      </div>
      <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 13, color: '#595959', lineHeight: 1.6 }}>
        {COMMUNITY_TOPICS.map(t => <li key={t}>{t}</li>)}
      </ul>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
      <a
        href={COMMUNITY_URL}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '7px 14px', borderRadius: 6,
          border: `1px solid ${GITHUB_INK}`, color: GITHUB_INK, background: '#fff',
          fontSize: 13, fontWeight: 600, textDecoration: 'none',
          transition: 'background 0.15s, color 0.15s',
        }}
        {...hoverHandlers(
          { background: GITHUB_INK, color: '#fff' },
          { background: '#fff', color: GITHUB_INK },
        )}
      >
        <GitHubLogo size={16} />
        Join the discussion
      </a>
      </div>
    </div>
  );
};

export default CommunityLink;
