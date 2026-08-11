// Deprecated shim — kept for backwards compatibility.
// New code should import directly from './subscriptions.routes', './notifications.routes', './analytics.routes'.
import subscriptionsRouter from './subscriptions.routes';
import notificationsRouter from './notifications.routes';
import analyticsRouter from './analytics.routes';

export { subscriptionsRouter, notificationsRouter, analyticsRouter };
