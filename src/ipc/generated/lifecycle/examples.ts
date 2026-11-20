// Written by the lifecycle crate's test `the_wire_examples_are_written_beside_the_exported_types`. Do not edit.

import type { Due } from "./Due";
import type { Forgotten } from "./Forgotten";
import type { Outcome } from "./Outcome";
import type { Refusal } from "./Refusal";
import type { Reply } from "./Reply";
import type { Versioned } from "./Versioned";

export const forgotten: Forgotten = {
  "panes": [
    "pane-9"
  ],
  "teams": [
    "team-gone"
  ],
  "workspaces": [
    "ws-gone"
  ]
};

export const verdicts: { source: { workspaceId: string; team: string | null; pane: string | null }; forgotten: boolean }[] = [
  {
    "forgotten": true,
    "source": {
      "pane": null,
      "team": null,
      "workspaceId": "ws-gone"
    }
  },
  {
    "forgotten": true,
    "source": {
      "pane": null,
      "team": "team-gone",
      "workspaceId": "ws-a"
    }
  },
  {
    "forgotten": true,
    "source": {
      "pane": "pane-9",
      "team": "team-1",
      "workspaceId": "ws-a"
    }
  },
  {
    "forgotten": false,
    "source": {
      "pane": "pane-1",
      "team": "team-1",
      "workspaceId": "ws-a"
    }
  },
  {
    "forgotten": false,
    "source": {
      "pane": "pane-1",
      "team": null,
      "workspaceId": "ws-a"
    }
  },
  {
    "forgotten": false,
    "source": {
      "pane": null,
      "team": null,
      "workspaceId": "ws-a"
    }
  }
];

export const refusals: Refusal[] = [
  {
    "kind": "alreadyClosing"
  },
  {
    "kind": "busy"
  },
  {
    "kind": "notFound"
  },
  {
    "kind": "barrierUp"
  },
  {
    "kind": "journalUnavailable"
  },
  {
    "kind": "journalStuck"
  },
  {
    "kind": "locationHeld"
  },
  {
    "kind": "targetLeaving"
  },
  {
    "kind": "archived"
  },
  {
    "kind": "sessionsDown"
  },
  {
    "kind": "forkStepExpired"
  },
  {
    "kind": "rejected",
    "reason": "role taken"
  }
];

export const replies: Reply[] = [
  {
    "answer": {
      "kind": "accepted",
      "minted": {
        "panes": [
          "pane-4"
        ],
        "team": "team-n",
        "workspace": null
      },
      "op": 9
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "leased",
      "permit": 2
    },
    "kind": "answered"
  },
  {
    "answer": {
      "attempt": 3,
      "kind": "admitted"
    },
    "kind": "answered"
  },
  {
    "answer": {
      "finishing": [
        1
      ],
      "kind": "booted"
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "alreadyClosing"
      }
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "busy"
      }
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "notFound"
      }
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "barrierUp"
      }
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "journalUnavailable"
      }
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "journalStuck"
      }
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "locationHeld"
      }
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "targetLeaving"
      }
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "archived"
      }
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "sessionsDown"
      }
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "forkStepExpired"
      }
    },
    "kind": "answered"
  },
  {
    "answer": {
      "kind": "refused",
      "refusal": {
        "kind": "rejected",
        "reason": "role taken"
      }
    },
    "kind": "answered"
  },
  {
    "kind": "unavailable"
  },
  {
    "kind": "unknown"
  }
];

export const outcomes: Outcome[] = [
  {
    "kind": "applied",
    "revision": 4
  },
  {
    "kind": "unchanged",
    "revision": null
  },
  {
    "kind": "rejected",
    "reason": "role taken"
  },
  {
    "discard": {
      "ifNeverStarted": [
        "/store/fork.jsonl"
      ],
      "onceStarted": [
        "/kd/spec.json"
      ],
      "plugin": "keepdeck.cli-a"
    },
    "kind": "forked"
  }
];

export const dues: Due[] = [
  {
    "cmd": {
      "draft": {
        "agentType": "cli-a"
      },
      "kind": "addWorkspace",
      "workspace": "ws-a"
    },
    "id": {
      "index": 0,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "draft": {
        "agentType": "cli-a"
      },
      "kind": "addTeam",
      "members": [
        {
          "draft": {
            "agentType": "cli-a"
          },
          "pane": "pane-4"
        }
      ],
      "place": {
        "branch": null,
        "cwd": "/repo",
        "kind": "attached"
      },
      "team": "team-n",
      "workspace": "ws-a"
    },
    "id": {
      "index": 1,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "kind": "retryTeam",
      "team": "team-n",
      "workspace": "ws-a"
    },
    "id": {
      "index": 2,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "branch": "kd/app/2",
      "cwd": "/wt/kd-app-2",
      "kind": "settleTeam",
      "team": "team-n",
      "workspace": "ws-a"
    },
    "id": {
      "index": 3,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "kind": "failTeam",
      "reason": "no space",
      "team": "team-n",
      "workspace": "ws-a"
    },
    "id": {
      "index": 4,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "draft": {
        "agentType": "cli-a"
      },
      "kind": "addPane",
      "pane": "pane-5",
      "team": "team-1",
      "workspace": "ws-a"
    },
    "id": {
      "index": 5,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "kind": "movePane",
      "newRoot": false,
      "pane": "pane-5",
      "to": "team-r",
      "workspace": "ws-a"
    },
    "id": {
      "index": 6,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "kind": "removePane",
      "pane": "pane-5",
      "workspace": "ws-a"
    },
    "id": {
      "index": 7,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "kind": "removeTeam",
      "team": "team-n",
      "workspace": "ws-a"
    },
    "id": {
      "index": 8,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "kind": "removeWorkspace",
      "workspace": "ws-a"
    },
    "id": {
      "index": 9,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "kind": "markArchived",
      "workspace": "ws-a"
    },
    "id": {
      "index": 10,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "kind": "clearArchived",
      "workspace": "ws-a"
    },
    "id": {
      "index": 11,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "kind": "markSuspended",
      "pane": "pane-1",
      "workspace": "ws-a"
    },
    "id": {
      "index": 12,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "kind": "clearSuspended",
      "pane": "pane-1",
      "workspace": "ws-a"
    },
    "id": {
      "index": 13,
      "op": 1
    },
    "owner": "deck"
  },
  {
    "cmd": {
      "kind": "deleteTeamTasks",
      "team": "team-n",
      "workspace": "ws-a"
    },
    "id": {
      "index": 14,
      "op": 1
    },
    "owner": "boards"
  },
  {
    "cmd": {
      "kind": "forgetBoards",
      "workspace": "ws-a"
    },
    "id": {
      "index": 15,
      "op": 1
    },
    "owner": "boards"
  },
  {
    "cmd": {
      "kind": "retainTeams",
      "teams": [
        "team-1",
        "team-r"
      ]
    },
    "id": {
      "index": 16,
      "op": 1
    },
    "owner": "boards"
  },
  {
    "cmd": {
      "kind": "forgetPaneMail",
      "pane": "pane-5",
      "workspace": "ws-a"
    },
    "id": {
      "index": 17,
      "op": 1
    },
    "owner": "mail"
  },
  {
    "cmd": {
      "kind": "retainPanes",
      "panes": [
        "pane-1",
        "pane-2"
      ]
    },
    "id": {
      "index": 18,
      "op": 1
    },
    "owner": "mail"
  },
  {
    "cmd": {
      "kind": "retire",
      "pane": "pane-2",
      "workspace": "ws-a"
    },
    "id": {
      "index": 19,
      "op": 1
    },
    "owner": "runState"
  },
  {
    "cmd": {
      "kind": "prepareResume",
      "pane": "pane-2",
      "source": {
        "agent": "cli-a",
        "session": "s-1"
      },
      "workspace": "ws-a"
    },
    "id": {
      "index": 20,
      "op": 1
    },
    "owner": "runState"
  },
  {
    "cmd": {
      "kind": "dropBuild",
      "op": 3
    },
    "id": {
      "index": 21,
      "op": 1
    },
    "owner": "runState"
  },
  {
    "cmd": {
      "kind": "reportBinding",
      "op": 3,
      "pane": "pane-6",
      "workspace": "ws-a"
    },
    "id": {
      "index": 22,
      "op": 1
    },
    "owner": "runState"
  },
  {
    "cmd": {
      "kind": "worktreeNotDeleted",
      "path": "/wt/kd-app-1",
      "reason": "busy",
      "workspace": "ws-a"
    },
    "id": {
      "index": 23,
      "op": 1
    },
    "owner": "notices"
  },
  {
    "cmd": {
      "cwd": "/repo",
      "kind": "fork",
      "pane": "pane-1",
      "source": {
        "agent": "cli-a",
        "session": "s-1"
      },
      "workspace": "ws-a"
    },
    "id": {
      "index": 24,
      "op": 1
    },
    "owner": "forkStep"
  }
];

export const versioned: Versioned = {
  "snapshot": {
    "commands": [
      {
        "cmd": {
          "kind": "removePane",
          "pane": "pane-2",
          "workspace": "ws-a"
        },
        "id": {
          "index": 1,
          "op": 2
        },
        "owner": "deck"
      }
    ],
    "forgotten": {
      "panes": [
        "pane-2"
      ],
      "teams": [],
      "workspaces": []
    },
    "gates": {
      "team-1": {
        "addMember": true,
        "close": true,
        "retry": false
      },
      "team-r": {
        "addMember": true,
        "close": true,
        "retry": false
      }
    },
    "open": true,
    "panes": {
      "pane-1": "live",
      "pane-2": "leaving",
      "pane-3": "live"
    },
    "sessionsDown": false,
    "teams": {
      "team-1": "live",
      "team-r": "live"
    },
    "viewOnly": false,
    "workspaces": {
      "ws-a": "live"
    }
  },
  "version": 7
};
