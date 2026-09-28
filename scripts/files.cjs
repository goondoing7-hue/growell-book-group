'use strict';

// Public deployment and Git publishing both use explicit paths. Adding a file
// to the directory alone must never publish a recovery file, secret, or fixture.
const DEPLOY_FILES = Object.freeze([
  'archive.js', 'archiveTimer.js', 'archiveDomain.js', 'archive.css',
  'materialsMedia.js', ...require('../vendor/pdfjs/manifest.json').files,
  'timerAlerts.js', 'timer-alert-sw.js',
  'dailyVerses.js', 'memberAccess.js', 'bookDetails.js', 'bookDetails.css',
  'dailyVerseDomain.js', 'popupHistory.js',
  'index.html', 'privacy.html', 'privateCrypto.js', 'privateCategories.js', 'privateCategories.css', 'homeDomain.js', 'home.css', 'community.css', 'communityDomain.js', 'communityFeatures.js',
  'habitDomain.js', 'habits.css', 'profile.js', 'profile.css', 'oauthDomain.js', 'readingTimerDomain.js', 'readingTimer.css', 'manifest.json', 'brand.css',
  'covers/action.jpg', 'covers/body.jpg', 'covers/emotion.jpg', 'covers/thought.jpg',
  'covers/favicon.ico', 'covers/logo.webp', 'covers/mascot-icon.png',
  'covers/og-image-v2.jpg', 'covers/icon-16.png', 'covers/icon-32.png',
  'covers/icon-180.png', 'covers/icon-192.png', 'covers/icon-512.png',
  'covers/icon-maskable-192.png', 'covers/icon-maskable-512.png',
  'covers/brand-book.svg', 'covers/growell-icon-32.png', 'covers/growell-icon-180.png',
  'covers/growell-icon-192.png', 'covers/growell-icon-512.png', 'covers/growell-maskable-192.png',
  'covers/growell-maskable-512.png', 'covers/favicon-v3.ico', 'covers/og-image-v3.jpg',
  'covers/og-image-v4.jpg', 'covers/og-image-v4.svg',
  'covers/habit-templates/theme-1.jpg', 'covers/habit-templates/theme-2.jpg',
  'covers/habit-templates/theme-3.jpg'
]);

const TEST_FILES = Object.freeze([
  'tests/archive-domain.test.cjs', 'tests/archive-timer.test.cjs', 'tests/archive-integration.test.cjs', 'tests/archive-ui.test.cjs', 'tests/book-search.test.cjs', 'tests/signup-notifications.test.cjs',
  'tests/book-details.test.cjs', 'tests/member-access.test.cjs', 'tests/signup-edge.test.cjs',
  'tests/materials-media.test.cjs', 'tests/materials-ui.test.cjs',
  'tests/timer-alerts.test.cjs',
  'tests/daily-verse.test.cjs', 'tests/popup-history.test.cjs',
  'tests/deployment.test.cjs', 'tests/drafts.test.cjs', 'tests/studio-layout.test.cjs',
  'tests/private-crypto.test.cjs', 'tests/private-session.test.cjs', 'tests/private-categories.test.cjs',
  'tests/save-login.test.cjs', 'tests/recovery-flow.test.cjs', 'tests/home-domain.test.cjs', 'tests/home-ui.test.cjs', 'tests/worksheet-access.test.cjs',
  'tests/editor-colors.test.cjs', 'tests/editor-sanitize.test.cjs', 'tests/reading-timer.test.cjs', 'tests/reading-save.test.cjs', 'tests/reading-integration.test.cjs',
  'tests/profile.test.cjs', 'tests/habit-domain.test.cjs', 'tests/habit-edit.test.cjs', 'tests/community-load.test.cjs', 'tests/community-features.test.cjs', 'tests/oauth-domain.test.cjs', 'tests/oauth-flow.test.cjs'
]);

const PUBLISH_FILES = Object.freeze([
  'api/book-search.js',
  'server/signup-notifications.sql', 'server/signup-notifications-verification.sql', 'server/signup-notification-worker.ts', 'server/signup-notifications-schedule.sql', 'server/signup-notifications.md',
  'server/signup.ts', 'server/member-approval.sql', 'server/member-approval-verification.sql', 'server/member-approval-notes.md',
  'server/worksheet-locks.sql', 'server/worksheet-locks-verification.sql', 'server/question-replies.sql', 'server/question-replies-verification.sql',
  'server/question-reply-editing.sql', 'server/question-reply-editing-verification.sql',
  ...DEPLOY_FILES, ...TEST_FILES,
  'package.json', 'package-lock.json', 'vercel.json', '.gitignore',
  '.github/workflows/verify.yml', 'README.md', 'DEPLOYMENT.md', 'AGENTS.md', 'AUTH_SETUP.md', 'server/member-read-policy.sql', 'server/oauth-members.sql', 'server/oauth-interface.md',
  'server/oauth-verification.sql', 'server/recovery-owner.sql', 'server/recovery-owner-verification.sql', 'server/member-read-verification.sql',
  'server/habit-kind.sql', 'server/community-questions.sql', 'server/community-questions-verification.sql',
  'server/worksheet-admin-only.sql', 'server/worksheet-admin-verification.sql',
  'scripts/files.cjs', 'scripts/check.cjs', 'scripts/test.cjs',
  'scripts/build.cjs', 'scripts/publish.cjs'
]);

function isAllowedRemote(remote) {
  return /^https:\/\/github\.com\/goondoing7-hue\/growell-book-group(?:\.git)?$/.test(remote)
    || /^git@github\.com:goondoing7-hue\/growell-book-group(?:\.git)?$/.test(remote)
    || /^ssh:\/\/git@github\.com\/goondoing7-hue\/growell-book-group(?:\.git)?$/.test(remote);
}

function selectPublishPaths(paths) {
  const allowed = new Set(PUBLISH_FILES);
  return [...new Set(paths)].filter(file => allowed.has(file)).sort();
}

module.exports = { DEPLOY_FILES, TEST_FILES, PUBLISH_FILES, isAllowedRemote, selectPublishPaths };
