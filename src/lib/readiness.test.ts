import { summarizeReadiness } from './readiness';

const ok          = { status: 'ok' };
const degraded    = { status: 'degraded' };
const unavailable = { status: 'unavailable' };

describe('summarizeReadiness', () => {
  it('is ready when every service is ok', () => {
    expect(summarizeReadiness({ a: ok, b: ok }, { allowDegraded: false }))
      .toEqual({ status: 'ok', ready: true });
  });

  it('fails readiness on a degraded service by default', () => {
    expect(summarizeReadiness({ a: ok, b: degraded }, { allowDegraded: false }))
      .toEqual({ status: 'degraded', ready: false });
  });

  it('passes readiness on degraded services when AI_ALLOW_DEGRADED is on', () => {
    // The lightweight all-in-one build reports model_loaded:false and an
    // in-memory vector store, but is serving traffic.
    expect(summarizeReadiness({ a: ok, b: degraded }, { allowDegraded: true }))
      .toEqual({ status: 'degraded', ready: true });
  });

  it('never passes readiness when a service is unreachable', () => {
    expect(summarizeReadiness({ a: ok, b: unavailable }, { allowDegraded: true }))
      .toEqual({ status: 'unavailable', ready: false });
    expect(summarizeReadiness({ a: degraded, b: unavailable }, { allowDegraded: true }))
      .toEqual({ status: 'unavailable', ready: false });
  });

  it('reports unavailable rather than ok when there is nothing to check', () => {
    expect(summarizeReadiness({}, { allowDegraded: true }))
      .toEqual({ status: 'unavailable', ready: false });
  });
});
