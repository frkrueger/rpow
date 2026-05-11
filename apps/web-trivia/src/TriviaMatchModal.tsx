import type { LobbyEntry } from './api.js';

type ChallengerMode = { kind: 'challenger'; target: LobbyEntry };
type OffererMode = { kind: 'offerer'; matchId: string };

interface Props {
  mode: ChallengerMode | OffererMode;
  myEmail: string;
  onClose: () => void;
}

export function TriviaMatchModal(_props: Props) {
  return null;
}
