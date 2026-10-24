// An embedding host may supply a radio adapter without loading Busking's player.
export const canSetDevertListenMode = () => false;
export const getRadioStateSnapshot = () => null;
export const setDevertListenMode = () => false;
export const formatMainRadioAdCountdown = () => 'Main radio ad: host playback adapter not configured';
