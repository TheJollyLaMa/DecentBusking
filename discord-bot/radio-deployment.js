export function createRadioDeploymentGate({ getSession, getLiveHandoff = () => ({ ready: true }),
  now = () => Date.now(), leaseMs = 120000 } = {}) {
  let deploymentId = null, expiresAt = 0;
  return async ({ action, id }) => {
    if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(id || '') || !['drain', 'cancel'].includes(action)) {
      throw new Error('Invalid radio deployment handoff');
    }
    if (deploymentId && expiresAt > now() && deploymentId !== id) {
      throw new Error('Another deployment holds the radio handoff');
    }
    const session = getSession();
    if (!session) throw new Error('Radio worker is not ready for deployment handoff');
    if (action === 'cancel') {
      expiresAt = 0; deploymentId = null;
      await session.drainForDeployment(0);
      return { draining: false, ready: false };
    }
    deploymentId = id;
    expiresAt = now() + leaseMs;
    let status = await session.drainForDeployment(expiresAt);
    const liveHandoff = await getLiveHandoff();
    if (!liveHandoff || typeof liveHandoff.ready !== 'boolean') throw new Error('Live recording handoff is not verified');
    status = { ...status, ready: status.ready && liveHandoff.ready,
      ...(liveHandoff.ready ? {} : { liveRecordingPending: true }) };
    if (status.ready) {
      expiresAt = now() + 15 * 60_000;
      status = await session.drainForDeployment(expiresAt);
    }
    return { ...status, deploymentId };
  };
}
