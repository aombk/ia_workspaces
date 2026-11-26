/**
 * The exercises a movement break suggests, with a drawing of each.
 *
 * Drawn here rather than borrowed: the open exercise collections are gym
 * photographs with mixed or unclear licences, and what a break at a desk wants
 * is a two-minute move you can do in office clothes beside a chair. So each is
 * a stick figure given as a few key poses, which the break screen animates
 * between — data, not pictures, so it works offline, scales to any size and
 * takes the theme's colours.
 *
 * The figure faces the viewer (`front`) or the right (`side`), in a 200×200
 * box with the floor at y = 186. Every pose names every joint; the helpers
 * below start from a resting pose and move only what the exercise moves.
 */
import type { BreakPosture } from './moveBreaks'

export type Joint =
  | 'head'
  | 'neck'
  | 'lSh'
  | 'rSh'
  | 'lEl'
  | 'rEl'
  | 'lHa'
  | 'rHa'
  | 'pelvis'
  | 'lHip'
  | 'rHip'
  | 'lKn'
  | 'rKn'
  | 'lAn'
  | 'rAn'
  | 'lToe'
  | 'rToe'

export type Pose = Record<Joint, [number, number]>

/**
 * Things somebody may have at their desk. An exercise that needs one is only
 * suggested to someone who has said they have it; everything without one is
 * suggested to everybody.
 */
export type Equipment = 'band' | 'bar' | 'dumbbells' | 'ankle' | 'kettlebell' | 'step' | 'mat' | 'rope'

export const EQUIPMENT: Array<{ id: Equipment; label: string }> = [
  { id: 'band', label: 'Resistance band' },
  { id: 'bar', label: 'Pull-up bar' },
  { id: 'dumbbells', label: 'Hand weights or dumbbells' },
  { id: 'ankle', label: 'Ankle weights' },
  { id: 'kettlebell', label: 'Kettlebell' },
  { id: 'step', label: 'A sturdy step, or stairs nearby' },
  { id: 'mat', label: 'A mat and room on the floor' },
  { id: 'rope', label: 'Skipping rope' },
]

/**
 * What an exercise asks of the body, so someone with a bad knee is never
 * shown a squat. Conservative on purpose: a tag here means "this loads it",
 * not "this will hurt it", and leaving an exercise out costs nothing.
 */
export type Strain = 'knees' | 'hips' | 'back' | 'shoulders' | 'wrists' | 'neck' | 'ankles' | 'balance' | 'impact'

export const STRAINS: Array<{ id: Strain; label: string }> = [
  { id: 'knees', label: 'Knees' },
  { id: 'hips', label: 'Hips' },
  { id: 'back', label: 'Lower back' },
  { id: 'shoulders', label: 'Shoulders' },
  { id: 'wrists', label: 'Wrists and hands' },
  { id: 'neck', label: 'Neck' },
  { id: 'ankles', label: 'Ankles and feet' },
  { id: 'balance', label: 'Balance \u2014 standing on one leg' },
  { id: 'impact', label: 'Jumping and impact' },
]

/**
 * What sort of exercise it is, so a break can be all stretching, or have no
 * yoga in it, or anything between. `rest` — the walk, resting the eyes,
 * breathing — is always offered, which is what keeps a break possible however
 * much else is switched off.
 */
export type ExerciseKind = 'cardio' | 'strength' | 'stretch' | 'yoga' | 'rest'

export const KINDS: Array<{ id: Exclude<ExerciseKind, 'rest'>; label: string; hint: string }> = [
  { id: 'cardio', label: 'Get moving', hint: 'Marching, jumping jacks, skipping — the heart rate up a little.' },
  { id: 'strength', label: 'Strength', hint: 'Squats, push-ups against the wall, and anything with weights or a band.' },
  { id: 'stretch', label: 'Stretches', hint: 'Hips, hamstrings, chest, neck and wrists — what a day in a chair tightens.' },
  { id: 'yoga', label: 'Yoga', hint: 'Held poses with slow breathing. The floor ones need a mat, ticked under equipment.' },
]

/** What the figure holds, drawn over it and moving with it. */
export type Hold = 'band' | 'bandAnchor' | 'dumbbells' | 'ankle' | 'kettlebell' | 'rope'

export interface Exercise {
  id: string
  name: string
  /** One or two lines: what to do, and how many. */
  how: string
  posture: BreakPosture
  kind: ExerciseKind
  /** Needed to do it. Absent is the body alone. */
  equipment?: Equipment
  /** What it loads; left out for anyone who has said to avoid any of these. */
  strain?: Strain[]
  /** Furniture drawn behind the figure. */
  prop?: 'chair' | 'wall' | 'gaze' | 'desk' | 'bar' | 'step' | 'mat' | 'post'
  hold?: Hold
  /** Key poses, looped through in order and back to the first. */
  poses: Pose[]
  /** Milliseconds from one pose to the next. */
  beat: number
}

type Partial2 = Partial<Record<Joint, [number, number]>>

const FRONT: Pose = {
  head: [100, 38],
  neck: [100, 56],
  lSh: [88, 60],
  rSh: [112, 60],
  lEl: [84, 86],
  rEl: [116, 86],
  lHa: [82, 110],
  rHa: [118, 110],
  pelvis: [100, 112],
  lHip: [93, 114],
  rHip: [107, 114],
  lKn: [92, 150],
  rKn: [108, 150],
  lAn: [92, 182],
  rAn: [108, 182],
  lToe: [86, 186],
  rToe: [114, 186],
}

// The far arm and leg sit a little apart from the near ones, so a side view
// still reads as two of each rather than one thick limb.
const SIDE: Pose = {
  head: [100, 38],
  neck: [100, 56],
  lSh: [100, 60],
  rSh: [100, 60],
  lEl: [105, 86],
  rEl: [99, 86],
  lHa: [113, 106],
  rHa: [104, 111],
  pelvis: [100, 112],
  lHip: [100, 112],
  rHip: [100, 112],
  lKn: [104, 150],
  rKn: [99, 150],
  lAn: [104, 182],
  rAn: [98, 182],
  lToe: [116, 186],
  rToe: [110, 186],
}

const SEATED: Pose = {
  head: [96, 46],
  neck: [94, 64],
  lSh: [94, 68],
  rSh: [94, 68],
  lEl: [100, 94],
  rEl: [100, 94],
  lHa: [120, 112],
  rHa: [120, 112],
  pelvis: [92, 122],
  lHip: [92, 122],
  rHip: [92, 122],
  lKn: [130, 122],
  rKn: [130, 122],
  lAn: [130, 180],
  rAn: [130, 180],
  lToe: [142, 184],
  rToe: [142, 184],
}

const pose = (base: Pose, change: Partial2 = {}): Pose => ({ ...base, ...change })

/** Both sides at once, for side views where the two overlap. */
const both = (l: Joint, r: Joint, at: [number, number]): Partial2 => ({ [l]: at, [r]: at })

/** Everything moved by `dy`, except the joints named — the feet of a calf raise. */
function lifted(base: Pose, dy: number, keep: Joint[]): Pose {
  const out = { ...base }
  for (const joint of Object.keys(out) as Joint[]) {
    if (!keep.includes(joint)) out[joint] = [out[joint][0], out[joint][1] + dy]
  }
  return out
}

/** The whole figure moved. */
function moved(base: Pose, dx: number, dy: number): Pose {
  const out = { ...base }
  for (const joint of Object.keys(out) as Joint[]) out[joint] = [out[joint][0] + dx, out[joint][1] + dy]
  return out
}

/** Moves the named joints round a small circle, in four steps. */
function circle(base: Pose, joints: Joint[], r: number, follow: Partial<Record<Joint, number>> = {}): Pose[] {
  const steps: Array<[number, number]> = [
    [0, -r],
    [r, 0],
    [0, r],
    [-r, 0],
  ]
  return steps.map(([dx, dy]) => {
    const out = { ...base }
    for (const joint of joints) out[joint] = [base[joint][0] + dx, base[joint][1] + dy]
    for (const [joint, k] of Object.entries(follow) as Array<[Joint, number]>) {
      out[joint] = [base[joint][0] + dx * k, base[joint][1] + dy * k]
    }
    return out
  })
}

/** On the floor, for the mat exercises: on the back, knees bent. */
const BRIDGE_DOWN: Pose = {
  head: [36, 170],
  neck: [50, 176],
  lSh: [52, 176],
  rSh: [52, 176],
  lEl: [74, 182],
  rEl: [76, 182],
  lHa: [96, 183],
  rHa: [98, 183],
  pelvis: [104, 178],
  lHip: [104, 178],
  rHip: [104, 178],
  lKn: [136, 150],
  rKn: [132, 152],
  lAn: [148, 182],
  rAn: [144, 182],
  lToe: [160, 184],
  rToe: [156, 184],
}

const BRIDGE_UP: Pose = pose(BRIDGE_DOWN, {
  pelvis: [104, 150],
  lHip: [104, 150],
  rHip: [104, 150],
  lKn: [138, 142],
  rKn: [134, 144],
})

/** Face down on the forearms, facing right. */
const PLANK: Pose = {
  head: [156, 146],
  neck: [144, 154],
  lSh: [144, 156],
  rSh: [144, 156],
  lEl: [144, 182],
  rEl: [140, 182],
  lHa: [162, 183],
  rHa: [158, 183],
  pelvis: [96, 162],
  lHip: [96, 162],
  rHip: [96, 162],
  lKn: [68, 170],
  rKn: [66, 171],
  lAn: [40, 178],
  rAn: [38, 179],
  lToe: [36, 185],
  rToe: [34, 185],
}

/** On hands and knees, facing right: the start of the floor yoga. */
const TABLETOP: Pose = {
  head: [170, 138],
  neck: [156, 146],
  lSh: [154, 148],
  rSh: [154, 148],
  lEl: [156, 166],
  rEl: [152, 166],
  lHa: [158, 184],
  rHa: [154, 184],
  pelvis: [100, 148],
  lHip: [100, 148],
  rHip: [100, 148],
  lKn: [104, 182],
  rKn: [100, 182],
  lAn: [70, 184],
  rAn: [66, 184],
  lToe: [62, 186],
  rToe: [58, 186],
}

/** Face down, propped on the forearms, facing right. */
const PRONE: Pose = {
  head: [168, 172],
  neck: [152, 176],
  lSh: [150, 177],
  rSh: [150, 177],
  lEl: [148, 183],
  rEl: [144, 183],
  lHa: [170, 184],
  rHa: [166, 184],
  pelvis: [96, 180],
  lHip: [96, 180],
  rHip: [96, 180],
  lKn: [60, 182],
  rKn: [58, 182],
  lAn: [26, 182],
  rAn: [24, 182],
  lToe: [20, 186],
  rToe: [18, 186],
}

export const EXERCISES: Exercise[] = [
  // ------------------------------------------------------------ standing
  {
    id: 'squat',
    name: 'Chair squats',
    how: 'Feet hip-width, sit back as if onto your chair and stand up again. Slowly — about 12.',
    posture: 'standing',
    kind: 'strength',
    strain: ['knees', 'hips'],
    beat: 1400,
    poses: [
      SIDE,
      pose(SIDE, {
        head: [114, 72],
        neck: [108, 88],
        ...both('lSh', 'rSh', [108, 92]),
        ...both('lEl', 'rEl', [130, 92]),
        ...both('lHa', 'rHa', [152, 90]),
        pelvis: [80, 138],
        ...both('lHip', 'rHip', [80, 138]),
        ...both('lKn', 'rKn', [112, 146]),
      }),
    ],
  },
  {
    id: 'calf',
    name: 'Calf raises',
    how: 'A hand on the desk for balance. Up onto your toes, hold a moment, down slowly. About 15.',
    posture: 'standing',
    kind: 'strength',
    strain: ['ankles'],
    prop: 'desk',
    beat: 1100,
    poses: [
      pose(SIDE, { ...both('lEl', 'rEl', [116, 86]), ...both('lHa', 'rHa', [134, 106]) }),
      pose(lifted(pose(SIDE, { ...both('lEl', 'rEl', [116, 80]) }), -9, ['lToe', 'rToe', 'lHa', 'rHa']), {
        lAn: [107, 173],
        rAn: [101, 173],
        ...both('lHa', 'rHa', [134, 106]),
      }),
    ],
  },
  {
    id: 'march',
    name: 'March on the spot',
    how: 'Knees up towards hip height, arms swinging. Keep it going for the whole minute.',
    posture: 'standing',
    kind: 'cardio',
    strain: ['hips'],
    beat: 550,
    poses: [
      pose(FRONT, { lKn: [90, 128], lAn: [92, 160], lToe: [86, 164], rEl: [122, 80], rHa: [116, 64], lEl: [80, 90], lHa: [76, 112] }),
      pose(FRONT, { rKn: [110, 128], rAn: [108, 160], rToe: [114, 164], lEl: [78, 80], lHa: [84, 64], rEl: [120, 90], rHa: [124, 112] }),
    ],
  },
  {
    id: 'wallpush',
    name: 'Wall push-ups',
    how: 'Hands on the wall at shoulder height, a step back. Bend the elbows, push away. About 12.',
    posture: 'standing',
    kind: 'strength',
    strain: ['wrists', 'shoulders'],
    prop: 'wall',
    beat: 1300,
    poses: [
      pose(SIDE, {
        head: [140, 58],
        neck: [130, 72],
        ...both('lSh', 'rSh', [130, 74]),
        ...both('lEl', 'rEl', [146, 73]),
        ...both('lHa', 'rHa', [160, 72]),
        pelvis: [96, 122],
        ...both('lHip', 'rHip', [96, 122]),
        ...both('lKn', 'rKn', [82, 152]),
        ...both('lAn', 'rAn', [70, 182]),
        ...both('lToe', 'rToe', [82, 186]),
      }),
      pose(SIDE, {
        head: [152, 70],
        neck: [142, 82],
        ...both('lSh', 'rSh', [142, 84]),
        ...both('lEl', 'rEl', [146, 100]),
        ...both('lHa', 'rHa', [160, 74]),
        pelvis: [104, 126],
        ...both('lHip', 'rHip', [104, 126]),
        ...both('lKn', 'rKn', [86, 154]),
        ...both('lAn', 'rAn', [70, 182]),
        ...both('lToe', 'rToe', [82, 186]),
      }),
    ],
  },
  {
    id: 'armcircles',
    name: 'Arm circles',
    how: 'Arms straight out to the sides, small circles. Half the minute forwards, half backwards.',
    posture: 'standing',
    kind: 'cardio',
    strain: ['shoulders'],
    beat: 260,
    poses: circle(pose(FRONT, { lEl: [64, 62], lHa: [40, 62], rEl: [136, 62], rHa: [160, 62] }), ['lHa', 'rHa'], 7, {
      lEl: 0.4,
      rEl: 0.4,
    }),
  },
  {
    id: 'chest',
    name: 'Chest opener',
    how: 'Hands in front of your chest, then open the arms wide and squeeze the shoulder blades. Breathe in as you open.',
    posture: 'standing',
    kind: 'stretch',
    strain: ['shoulders'],
    beat: 1600,
    poses: [
      pose(FRONT, { lEl: [80, 74], rEl: [120, 74], lHa: [94, 66], rHa: [106, 66] }),
      pose(FRONT, { head: [100, 36], lEl: [66, 68], rEl: [134, 68], lHa: [50, 56], rHa: [150, 56] }),
    ],
  },
  {
    id: 'sidebend',
    name: 'Side bends',
    how: 'One arm over your head, lean the other way and let the other hand slide down your leg. Alternate, slowly.',
    posture: 'standing',
    kind: 'stretch',
    strain: ['back'],
    beat: 1700,
    poses: [
      pose(FRONT, { head: [112, 40], neck: [106, 57], lSh: [94, 59], rSh: [117, 64], lEl: [96, 34], lHa: [112, 16], rEl: [124, 88], rHa: [124, 114] }),
      FRONT,
      pose(FRONT, { head: [88, 40], neck: [94, 57], lSh: [83, 64], rSh: [106, 59], rEl: [104, 34], rHa: [88, 16], lEl: [76, 88], lHa: [76, 114] }),
      FRONT,
    ],
  },
  {
    id: 'hips',
    name: 'Hip circles',
    how: 'Hands on hips, feet planted, draw slow circles with your hips. Change direction halfway.',
    posture: 'standing',
    kind: 'cardio',
    strain: ['back', 'hips'],
    beat: 420,
    poses: circle(
      pose(FRONT, { lEl: [78, 90], lHa: [92, 112], rEl: [122, 90], rHa: [108, 112] }),
      ['pelvis', 'lHip', 'rHip', 'lHa', 'rHa'],
      6,
      { lEl: 0.6, rEl: 0.6, lKn: 0.5, rKn: 0.5, neck: -0.3, head: -0.3, lSh: -0.3, rSh: -0.3 }
    ),
  },
  {
    id: 'walk',
    name: 'Walk',
    how: 'Walk around — get some water, look out of a window. Away from the desk until the time is up.',
    posture: 'standing',
    kind: 'rest',
    beat: 520,
    poses: [
      pose(SIDE, { lKn: [108, 148], lAn: [114, 180], lToe: [126, 184], rKn: [96, 150], rAn: [84, 178], rToe: [94, 186], lEl: [94, 84], lHa: [88, 106], rEl: [106, 84], rHa: [114, 104] }),
      pose(SIDE, { rKn: [108, 148], rAn: [114, 180], rToe: [126, 184], lKn: [96, 150], lAn: [84, 178], lToe: [94, 186], rEl: [94, 84], rHa: [88, 106], lEl: [106, 84], lHa: [114, 104] }),
    ],
  },
  // What sitting does most to a body, undone: the hips and hamstrings it
  // shortens, the back it rounds, the legs it leaves idle.
  {
    id: 'hipflexor',
    name: 'Hip flexor stretch',
    how: 'One foot a long step in front of the other. Tuck the tailbone and ease the hips forward until the front of the back hip stretches. Half the time each side.',
    posture: 'standing',
    kind: 'stretch',
    strain: ['hips'],
    beat: 2200,
    poses: [
      pose(SIDE, {
        ...both('lHip', 'rHip', [100, 114]),
        lKn: [118, 146],
        lAn: [120, 182],
        lToe: [132, 186],
        rKn: [86, 148],
        rAn: [72, 178],
        rToe: [80, 186],
        lEl: [88, 88],
        lHa: [98, 110],
        rEl: [92, 86],
        rHa: [100, 110],
      }),
      pose(SIDE, {
        head: [106, 48],
        neck: [107, 66],
        ...both('lSh', 'rSh', [107, 70]),
        pelvis: [108, 124],
        ...both('lHip', 'rHip', [108, 124]),
        lKn: [132, 150],
        lAn: [120, 182],
        lToe: [132, 186],
        rKn: [88, 152],
        rAn: [72, 178],
        rToe: [80, 186],
        lEl: [95, 96],
        lHa: [106, 120],
        rEl: [99, 94],
        rHa: [108, 120],
      }),
    ],
  },
  {
    id: 'hamstring',
    name: 'Hamstring stretch',
    how: 'Heel of one foot forward, toes up, leg straight. Bend the other knee and fold forward from the hips, back flat, until the back of the leg stretches. Half the time each side.',
    posture: 'standing',
    kind: 'stretch',
    strain: ['back'],
    beat: 2200,
    poses: [
      pose(SIDE, {
        head: [96, 38],
        neck: [96, 56],
        ...both('lSh', 'rSh', [96, 60]),
        pelvis: [96, 114],
        ...both('lHip', 'rHip', [96, 114]),
        lKn: [114, 148],
        lAn: [132, 180],
        lToe: [136, 168],
        rKn: [94, 150],
        rAn: [94, 182],
        rToe: [106, 186],
        lEl: [104, 86],
        lHa: [112, 110],
        rEl: [100, 86],
        rHa: [110, 112],
      }),
      pose(SIDE, {
        head: [142, 64],
        neck: [129, 77],
        ...both('lSh', 'rSh', [128, 80]),
        pelvis: [88, 118],
        ...both('lHip', 'rHip', [88, 118]),
        lKn: [108, 148],
        lAn: [128, 178],
        lToe: [132, 166],
        rKn: [96, 150],
        rAn: [94, 182],
        rToe: [106, 186],
        lEl: [128, 104],
        lHa: [126, 128],
        rEl: [124, 106],
        rHa: [122, 130],
      }),
    ],
  },
  {
    id: 'backext',
    name: 'Standing back extension',
    how: 'Hands on your lower back, fingers down. Lean back gently and look up a little, then come up straight. Slowly, about 10.',
    posture: 'standing',
    kind: 'stretch',
    strain: ['back'],
    beat: 1800,
    poses: [
      pose(SIDE, { lEl: [88, 86], lHa: [94, 110], rEl: [92, 86], rHa: [96, 110] }),
      pose(SIDE, {
        head: [80, 45],
        neck: [88, 61],
        ...both('lSh', 'rSh', [88, 65]),
        pelvis: [104, 112],
        ...both('lHip', 'rHip', [104, 112]),
        lEl: [82, 88],
        lHa: [96, 108],
        rEl: [86, 88],
        rHa: [98, 108],
      }),
    ],
  },
  {
    id: 'twist',
    name: 'Torso twists',
    how: 'Feet planted, arms folded at chest height. Turn the shoulders slowly to one side, back through the middle, then the other. Hips stay facing forward.',
    posture: 'standing',
    kind: 'stretch',
    strain: ['back'],
    beat: 1100,
    poses: [
      pose(FRONT, { lEl: [74, 72], rEl: [126, 72], lHa: [94, 70], rHa: [106, 70] }),
      pose(FRONT, { head: [104, 38], lSh: [93, 60], rSh: [109, 60], lEl: [104, 74], lHa: [122, 68], rEl: [128, 70], rHa: [118, 68] }),
      pose(FRONT, { lEl: [74, 72], rEl: [126, 72], lHa: [94, 70], rHa: [106, 70] }),
      pose(FRONT, { head: [96, 38], lSh: [91, 60], rSh: [107, 60], rEl: [96, 74], rHa: [78, 68], lEl: [72, 70], lHa: [82, 68] }),
    ],
  },
  {
    id: 'lunge',
    name: 'Reverse lunges',
    how: 'Step one foot back and bend both knees until the back knee nearly touches the floor. Push back up. Alternate legs, about 10 each.',
    posture: 'standing',
    kind: 'strength',
    strain: ['knees', 'balance'],
    beat: 1400,
    poses: [
      pose(SIDE, { lEl: [88, 88], lHa: [98, 110], rEl: [92, 86], rHa: [100, 110] }),
      pose(SIDE, {
        head: [96, 64],
        neck: [96, 82],
        ...both('lSh', 'rSh', [96, 86]),
        pelvis: [96, 140],
        ...both('lHip', 'rHip', [96, 140]),
        rKn: [130, 146],
        rAn: [128, 182],
        rToe: [140, 186],
        lKn: [90, 174],
        lAn: [58, 176],
        lToe: [68, 186],
        lEl: [84, 112],
        lHa: [94, 136],
        rEl: [88, 110],
        rHa: [96, 136],
      }),
    ],
  },
  {
    id: 'balance',
    name: 'Stand on one leg',
    how: 'Near the desk in case you wobble. Lift one foot and hold for thirty seconds, eyes on a point ahead, then the other. Harder: close your eyes.',
    posture: 'standing',
    kind: 'strength',
    strain: ['balance', 'ankles'],
    beat: 1600,
    poses: [
      pose(FRONT, { rKn: [110, 130], rAn: [112, 160], rToe: [118, 164], lEl: [74, 80], lHa: [60, 96], rEl: [126, 80], rHa: [140, 96] }),
      pose(FRONT, { head: [101, 38], rKn: [110, 130], rAn: [112, 160], rToe: [118, 164], lEl: [74, 78], lHa: [58, 92], rEl: [126, 82], rHa: [142, 100] }),
    ],
  },
  {
    id: 'jacks',
    name: 'Jumping jacks',
    how: 'Jump the feet apart as the arms go up, back together as they come down. Thirty seconds, a breather, thirty more \u2014 or step them out without the jump.',
    posture: 'standing',
    kind: 'cardio',
    strain: ['impact', 'knees', 'ankles'],
    beat: 420,
    poses: [
      FRONT,
      pose(FRONT, {
        lEl: [76, 40],
        lHa: [70, 18],
        rEl: [124, 40],
        rHa: [130, 18],
        lKn: [86, 148],
        rKn: [114, 148],
        lAn: [80, 182],
        rAn: [120, 182],
        lToe: [74, 186],
        rToe: [126, 186],
      }),
    ],
  },

  // ------------------------------------------------------------- seated
  {
    id: 'neck',
    name: 'Neck rolls',
    how: 'Sit tall. Chin to chest, then roll the head slowly round — never forced. A few each way.',
    posture: 'seated',
    kind: 'stretch',
    strain: ['neck'],
    prop: 'chair',
    beat: 1300,
    poses: [SEATED, pose(SEATED, { head: [108, 54] }), SEATED, pose(SEATED, { head: [88, 48] })],
  },
  {
    id: 'shoulders',
    name: 'Shoulder rolls',
    how: 'Shoulders up to the ears, back, down, round. Slow, ten times, then the other way.',
    posture: 'seated',
    kind: 'stretch',
    strain: ['shoulders'],
    prop: 'chair',
    beat: 500,
    poses: circle(SEATED, ['lSh', 'rSh'], 5, { lEl: 0.5, rEl: 0.5, neck: 0.3, head: 0.3 }),
  },
  {
    id: 'legext',
    name: 'Leg extensions',
    how: 'Straighten one leg until it is level, hold for three, lower. Ten each leg.',
    posture: 'seated',
    kind: 'strength',
    strain: ['knees'],
    prop: 'chair',
    beat: 1500,
    poses: [SEATED, pose(SEATED, { lAn: [170, 118], lToe: [176, 106] })],
  },
  {
    id: 'reach',
    name: 'Overhead reach',
    how: 'Lace your fingers and push your palms up to the ceiling. Hold, breathe, lower. Repeat.',
    posture: 'seated',
    kind: 'stretch',
    strain: ['shoulders'],
    prop: 'chair',
    beat: 1800,
    poses: [SEATED, pose(SEATED, { head: [97, 44], ...both('lEl', 'rEl', [98, 40]), ...both('lHa', 'rHa', [100, 16]) })],
  },
  {
    id: 'catcow',
    name: 'Seated cat–cow',
    how: 'Hands on knees. Round your back and drop the head, then arch and look up. With your breathing.',
    posture: 'seated',
    kind: 'yoga',
    strain: ['back', 'neck'],
    prop: 'chair',
    beat: 1800,
    poses: [
      pose(SEATED, { neck: [106, 70], head: [118, 62], ...both('lSh', 'rSh', [106, 74]), ...both('lEl', 'rEl', [118, 96]), ...both('lHa', 'rHa', [128, 118]) }),
      pose(SEATED, { neck: [88, 62], head: [90, 44], ...both('lSh', 'rSh', [88, 66]), ...both('lEl', 'rEl', [104, 92]) }),
    ],
  },
  {
    id: 'seatmarch',
    name: 'Seated march',
    how: 'Lift one knee, then the other, as if marching. Sit tall and keep it brisk.',
    posture: 'seated',
    kind: 'cardio',
    strain: ['hips'],
    prop: 'chair',
    beat: 600,
    poses: [SEATED, pose(SEATED, { lKn: [128, 106], lAn: [134, 164], lToe: [146, 168] })],
  },
  {
    id: 'eyes',
    name: 'Eye rest',
    how: 'Look at something at least six metres away for twenty seconds, blink slowly, then close your eyes for a few breaths.',
    posture: 'seated',
    kind: 'rest',
    prop: 'gaze',
    beat: 2400,
    poses: [pose(SEATED, { head: [98, 45] }), pose(SEATED, { head: [96, 47] })],
  },
  // The hands, the neck and the spine: what a keyboard and a screen load all day.
  {
    id: 'wrists',
    name: 'Wrist and forearm stretch',
    how: 'One arm straight out, palm up. With the other hand, ease the fingers down and back. Then palm down, fingers towards you. Twenty seconds each way, each arm.',
    posture: 'seated',
    kind: 'stretch',
    strain: ['wrists'],
    prop: 'chair',
    beat: 2000,
    poses: [
      pose(SEATED, { lEl: [118, 68], lHa: [142, 68], rEl: [124, 80], rHa: [146, 58] }),
      pose(SEATED, { lEl: [118, 68], lHa: [142, 68], rEl: [124, 84], rHa: [146, 78] }),
    ],
  },
  {
    id: 'chintuck',
    name: 'Chin tucks',
    how: 'Sit tall, eyes level. Slide your head straight back as if making a double chin, hold for three, release. About 10.',
    posture: 'seated',
    kind: 'stretch',
    strain: ['neck'],
    prop: 'chair',
    beat: 1500,
    poses: [SEATED, pose(SEATED, { head: [89, 46], neck: [92, 64] })],
  },
  {
    id: 'seattwist',
    name: 'Seated twist',
    how: 'Sit tall, one hand on the opposite knee, the other on the back of the chair. Turn to look over your shoulder, breathe, come back. Each side a few times.',
    posture: 'seated',
    kind: 'yoga',
    strain: ['back'],
    prop: 'chair',
    beat: 2000,
    poses: [
      SEATED,
      pose(SEATED, { head: [92, 46], lSh: [86, 68], rSh: [104, 68], lEl: [78, 90], lHa: [76, 108], rEl: [114, 94], rHa: [128, 118] }),
    ],
  },

  // Yoga and stretches for a body that sits: the hips and the backs of the
  // legs it shortens, the chest and upper back it rounds, the hands it uses.
  {
    id: 'chairpose',
    name: 'Chair pose',
    how: 'Feet together. Sit back as if into a chair and raise your arms alongside your ears. Hold for five slow breaths, stand, and again — three or four times.',
    posture: 'standing',
    kind: 'yoga',
    strain: ['knees', 'hips'],
    beat: 2600,
    poses: [
      pose(SIDE, { ...both('lEl', 'rEl', [104, 36]), ...both('lHa', 'rHa', [108, 12]) }),
      pose(SIDE, {
        head: [112, 64],
        neck: [106, 80],
        ...both('lSh', 'rSh', [106, 84]),
        ...both('lEl', 'rEl', [115, 60]),
        ...both('lHa', 'rHa', [124, 37]),
        pelvis: [84, 132],
        ...both('lHip', 'rHip', [84, 132]),
        lKn: [118, 146],
        rKn: [114, 148],
      }),
    ],
  },
  {
    id: 'warrior',
    name: 'Warrior II',
    how: 'Feet wide, the right foot turned out. Bend the right knee over the ankle, arms out level, eyes over the right hand. Five breaths, then the other side; twice through.',
    posture: 'standing',
    kind: 'yoga',
    strain: ['knees', 'hips'],
    beat: 2800,
    poses: [
      pose(FRONT, {
        lEl: [64, 62],
        lHa: [40, 62],
        rEl: [136, 62],
        rHa: [160, 62],
        lHip: [93, 116],
        rHip: [107, 116],
        lKn: [80, 148],
        lAn: [66, 182],
        lToe: [58, 186],
        rKn: [120, 148],
        rAn: [134, 182],
        rToe: [142, 186],
      }),
      pose(FRONT, {
        head: [105, 50],
        neck: [100, 68],
        lSh: [88, 72],
        rSh: [112, 72],
        lEl: [64, 72],
        lHa: [40, 72],
        rEl: [136, 72],
        rHa: [160, 72],
        pelvis: [100, 124],
        lHip: [93, 126],
        rHip: [107, 126],
        lKn: [80, 154],
        lAn: [66, 182],
        lToe: [58, 186],
        rKn: [132, 146],
        rAn: [134, 182],
        rToe: [142, 186],
      }),
    ],
  },
  {
    id: 'tree',
    name: 'Tree pose',
    how: 'Stand on one foot and rest the other against the inside of the calf or thigh — never on the knee. Hands together at the chest, then overhead if you are steady. Thirty seconds, then the other side.',
    posture: 'standing',
    kind: 'yoga',
    strain: ['balance'],
    beat: 2600,
    poses: [
      pose(FRONT, {
        pelvis: [98, 112],
        lHip: [91, 114],
        rHip: [105, 114],
        lKn: [94, 150],
        lAn: [96, 182],
        lToe: [90, 186],
        rKn: [128, 134],
        rAn: [102, 154],
        rToe: [98, 160],
        lEl: [78, 82],
        lHa: [96, 72],
        rEl: [118, 82],
        rHa: [100, 72],
      }),
      pose(FRONT, {
        pelvis: [98, 112],
        lHip: [91, 114],
        rHip: [105, 114],
        lKn: [94, 150],
        lAn: [96, 182],
        lToe: [90, 186],
        rKn: [128, 134],
        rAn: [102, 154],
        rToe: [98, 160],
        lEl: [88, 36],
        lHa: [97, 13],
        rEl: [112, 36],
        rHa: [103, 13],
      }),
    ],
  },
  {
    id: 'halfsalute',
    name: 'Half sun salutation',
    how: 'Arms up as you breathe in; fold forward, knees soft, as you breathe out; halfway up with a flat back, hands on the shins; fold again; then up. One movement per breath, round and round.',
    posture: 'standing',
    kind: 'yoga',
    strain: ['back'],
    beat: 2200,
    poses: [
      pose(SIDE, { ...both('lEl', 'rEl', [104, 36]), ...both('lHa', 'rHa', [108, 12]) }),
      pose(SIDE, {
        head: [128, 166],
        neck: [124, 148],
        ...both('lSh', 'rSh', [122, 150]),
        ...both('lEl', 'rEl', [122, 170]),
        ...both('lHa', 'rHa', [120, 186]),
        pelvis: [90, 112],
        ...both('lHip', 'rHip', [90, 112]),
        lKn: [106, 146],
        rKn: [102, 148],
      }),
      pose(SIDE, {
        head: [158, 96],
        neck: [144, 104],
        ...both('lSh', 'rSh', [142, 106]),
        ...both('lEl', 'rEl', [138, 128]),
        ...both('lHa', 'rHa', [120, 148]),
        pelvis: [90, 112],
        ...both('lHip', 'rHip', [90, 112]),
        lKn: [106, 146],
        rKn: [102, 148],
      }),
      pose(SIDE, {
        head: [128, 166],
        neck: [124, 148],
        ...both('lSh', 'rSh', [122, 150]),
        ...both('lEl', 'rEl', [122, 170]),
        ...both('lHa', 'rHa', [120, 186]),
        pelvis: [90, 112],
        ...both('lHip', 'rHip', [90, 112]),
        lKn: [106, 146],
        rKn: [102, 148],
      }),
    ],
  },
  {
    id: 'forwardfold',
    name: 'Standing forward fold',
    how: 'Feet hip-width, knees soft. Fold from the hips and let the head and arms hang heavy; sway a little. Roll up slowly, head last, after half a minute. Two or three times.',
    posture: 'standing',
    kind: 'yoga',
    strain: ['back'],
    beat: 3000,
    poses: [
      SIDE,
      pose(SIDE, {
        head: [128, 166],
        neck: [124, 148],
        ...both('lSh', 'rSh', [122, 150]),
        lEl: [124, 170],
        rEl: [120, 170],
        lHa: [122, 186],
        rHa: [118, 186],
        pelvis: [90, 112],
        ...both('lHip', 'rHip', [90, 112]),
        lKn: [106, 146],
        rKn: [102, 148],
      }),
    ],
  },
  {
    id: 'quad',
    name: 'Standing quad stretch',
    how: 'A hand on the desk. Bend one knee and hold that ankle behind you, knees side by side, hips pushed gently forward. Thirty seconds a side.',
    posture: 'standing',
    kind: 'stretch',
    strain: ['knees', 'balance'],
    prop: 'desk',
    beat: 2400,
    poses: [
      pose(SIDE, { ...both('lEl', 'rEl', [116, 86]), ...both('lHa', 'rHa', [134, 106]) }),
      pose(SIDE, {
        lEl: [116, 86],
        lHa: [134, 106],
        rEl: [90, 96],
        rHa: [80, 120],
        rKn: [98, 150],
        rAn: [80, 124],
        rToe: [74, 116],
      }),
    ],
  },
  {
    id: 'angels',
    name: 'Wall angels',
    how: 'Back, head and arms against a wall — or just stand tall. Arms in a W, elbows bent, then slide them up into a Y and down again. Slowly, about 10.',
    posture: 'standing',
    kind: 'stretch',
    strain: ['shoulders'],
    beat: 1800,
    poses: [
      pose(FRONT, { lEl: [70, 66], lHa: [72, 42], rEl: [130, 66], rHa: [128, 42] }),
      pose(FRONT, { lEl: [80, 38], lHa: [70, 15], rEl: [120, 38], rHa: [130, 15] }),
    ],
  },
  {
    id: 'triceps',
    name: 'Overhead shoulder stretch',
    how: 'One hand down between the shoulder blades, the other easing that elbow back behind your head. Twenty seconds, swap, twice each side.',
    posture: 'standing',
    kind: 'stretch',
    strain: ['shoulders'],
    beat: 2600,
    poses: [
      pose(FRONT, { head: [97, 38], rEl: [114, 28], rHa: [102, 50], lEl: [84, 38], lHa: [110, 28] }),
      pose(FRONT, { head: [103, 38], lEl: [86, 28], lHa: [98, 50], rEl: [116, 38], rHa: [90, 28] }),
    ],
  },
  {
    id: 'kneeelbow',
    name: 'Standing knee to elbow',
    how: 'Hands behind your head. Lift one knee and bring the opposite elbow down to meet it, then the other side. Brisk, for the whole minute.',
    posture: 'standing',
    kind: 'cardio',
    strain: ['hips', 'balance'],
    beat: 700,
    poses: [
      pose(FRONT, { lEl: [72, 50], lHa: [92, 40], rEl: [128, 50], rHa: [108, 40] }),
      pose(FRONT, {
        head: [104, 42],
        neck: [102, 60],
        lSh: [92, 64],
        rSh: [114, 62],
        lEl: [104, 86],
        lHa: [96, 50],
        rEl: [130, 54],
        rHa: [110, 44],
        rKn: [106, 124],
        rAn: [110, 156],
        rToe: [116, 160],
      }),
      pose(FRONT, { lEl: [72, 50], lHa: [92, 40], rEl: [128, 50], rHa: [108, 40] }),
      pose(FRONT, {
        head: [96, 42],
        neck: [98, 60],
        lSh: [86, 62],
        rSh: [108, 64],
        rEl: [96, 86],
        rHa: [104, 50],
        lEl: [70, 54],
        lHa: [90, 44],
        lKn: [94, 124],
        lAn: [90, 156],
        lToe: [84, 160],
      }),
    ],
  },
  {
    id: 'boxing',
    name: 'Shadow boxing',
    how: 'Feet staggered, fists by your chin. Punch straight out, one hand then the other, turning the hips into each. Thirty seconds fast, thirty easy, again.',
    posture: 'standing',
    kind: 'cardio',
    strain: ['shoulders'],
    beat: 380,
    poses: [
      pose(SIDE, { ...both('lEl', 'rEl', [110, 80]), ...both('lHa', 'rHa', [118, 58]), lKn: [108, 148], lAn: [116, 182], lToe: [128, 186] }),
      pose(SIDE, { lEl: [110, 80], lHa: [118, 58], rEl: [124, 62], rHa: [148, 60], lKn: [108, 148], lAn: [116, 182], lToe: [128, 186] }),
      pose(SIDE, { ...both('lEl', 'rEl', [110, 80]), ...both('lHa', 'rHa', [118, 58]), lKn: [108, 148], lAn: [116, 182], lToe: [128, 186] }),
      pose(SIDE, { rEl: [110, 80], rHa: [118, 58], lEl: [124, 62], lHa: [148, 60], lKn: [108, 148], lAn: [116, 182], lToe: [128, 186] }),
    ],
  },

  // ------------------------------------------------------- seated yoga
  {
    id: 'figurefour',
    name: 'Seated figure-four',
    how: 'One ankle across the other knee, foot flexed. Sit tall, then hinge forward with a flat back until the outside of the hip stretches. Thirty seconds a side — the muscle sitting tightens most.',
    posture: 'seated',
    kind: 'yoga',
    strain: ['hips', 'knees'],
    prop: 'chair',
    beat: 2800,
    poses: [
      pose(SEATED, { rKn: [120, 106], rAn: [134, 118], rToe: [144, 112], ...both('lEl', 'rEl', [104, 92]), ...both('lHa', 'rHa', [120, 106]) }),
      pose(SEATED, {
        head: [122, 56],
        neck: [112, 70],
        ...both('lSh', 'rSh', [110, 74]),
        ...both('lEl', 'rEl', [120, 96]),
        ...both('lHa', 'rHa', [128, 112]),
        rKn: [120, 106],
        rAn: [134, 118],
        rToe: [144, 112],
      }),
    ],
  },
  {
    id: 'seatfold',
    name: 'Seated forward fold',
    how: 'Feet wide and flat. Fold forward over your thighs and let your arms and head hang towards the floor. Breathe into your back for half a minute, come up slowly, again.',
    posture: 'seated',
    kind: 'yoga',
    strain: ['back'],
    prop: 'chair',
    beat: 3000,
    poses: [
      SEATED,
      pose(SEATED, {
        head: [150, 122],
        neck: [138, 110],
        ...both('lSh', 'rSh', [136, 112]),
        lEl: [140, 136],
        rEl: [136, 136],
        lHa: [142, 160],
        rHa: [138, 160],
      }),
    ],
  },
  {
    id: 'eagle',
    name: 'Eagle arms',
    how: 'Cross one arm under the other at the elbows and bring the palms together if you can. Lift the elbows and breathe into the space between the shoulder blades. Thirty seconds, swap arms.',
    posture: 'seated',
    kind: 'yoga',
    strain: ['shoulders'],
    prop: 'chair',
    beat: 2600,
    poses: [
      pose(SEATED, { ...both('lEl', 'rEl', [116, 80]), ...both('lHa', 'rHa', [116, 56]) }),
      pose(SEATED, { head: [97, 45], ...both('lEl', 'rEl', [118, 66]), ...both('lHa', 'rHa', [114, 42]) }),
    ],
  },
  {
    id: 'seathams',
    name: 'Seated hamstring stretch',
    how: 'Slide to the front of the seat, one leg straight with the heel down and toes up. Lean forward from the hips, back long, until the back of the leg stretches. Thirty seconds a side.',
    posture: 'seated',
    kind: 'stretch',
    strain: ['back'],
    prop: 'chair',
    beat: 2600,
    poses: [
      pose(SEATED, { lKn: [126, 138], lAn: [154, 166], lToe: [158, 154] }),
      pose(SEATED, {
        head: [126, 58],
        neck: [114, 70],
        ...both('lSh', 'rSh', [112, 74]),
        ...both('lEl', 'rEl', [122, 98]),
        ...both('lHa', 'rHa', [136, 120]),
        lKn: [126, 138],
        lAn: [154, 166],
        lToe: [158, 154],
      }),
    ],
  },
  {
    id: 'backbend',
    name: 'Chair-back extension',
    how: 'Hands behind your head, elbows wide. Lean back over the top of the chair back and look up a little, then sit tall again. Slowly, about 8.',
    posture: 'seated',
    kind: 'stretch',
    strain: ['back', 'neck'],
    prop: 'chair',
    beat: 2000,
    poses: [
      pose(SEATED, { ...both('lEl', 'rEl', [108, 48]), ...both('lHa', 'rHa', [86, 44]) }),
      pose(SEATED, {
        head: [80, 46],
        neck: [84, 63],
        ...both('lSh', 'rSh', [84, 67]),
        ...both('lEl', 'rEl', [98, 46]),
        ...both('lHa', 'rHa', [74, 44]),
      }),
    ],
  },
  {
    id: 'tendons',
    name: 'Finger and tendon glides',
    how: 'Hands out in front. Open the fingers wide, bend them into a hook, close into a fist, open again — slowly, ten rounds. Then let the hands hang and shake them out.',
    posture: 'seated',
    kind: 'stretch',
    strain: ['wrists'],
    prop: 'chair',
    beat: 1400,
    poses: [
      pose(SEATED, { ...both('lEl', 'rEl', [118, 76]), ...both('lHa', 'rHa', [142, 74]) }),
      pose(SEATED, { ...both('lEl', 'rEl', [118, 76]), ...both('lHa', 'rHa', [140, 80]) }),
    ],
  },
  {
    id: 'breathing',
    name: 'Slow breathing',
    how: 'Hands in your lap, shoulders down. In through the nose for four, hold for four, out for six. Breathing out longer than in is what settles a racing head.',
    posture: 'seated',
    kind: 'rest',
    prop: 'chair',
    beat: 4000,
    poses: [
      pose(SEATED, { ...both('lEl', 'rEl', [104, 94]), ...both('lHa', 'rHa', [122, 114]) }),
      pose(SEATED, {
        head: [96, 43],
        neck: [94, 61],
        ...both('lSh', 'rSh', [94, 65]),
        ...both('lEl', 'rEl', [104, 92]),
        ...both('lHa', 'rHa', [122, 114]),
      }),
    ],
  },

  // ------------------------------------------------------------ equipment
  {
    id: 'bandpull',
    name: 'Band pull-aparts',
    how: 'Band in both hands, arms straight out in front. Pull it apart until it reaches your chest, back slowly. About 15.',
    posture: 'standing',
    kind: 'strength',
    equipment: 'band',
    strain: ['shoulders'],
    hold: 'band',
    beat: 1300,
    poses: [
      pose(FRONT, { lEl: [86, 66], rEl: [114, 66], lHa: [94, 64], rHa: [106, 64] }),
      pose(FRONT, { lEl: [66, 62], rEl: [134, 62], lHa: [44, 62], rHa: [156, 62] }),
    ],
  },
  {
    id: 'bandrow',
    name: 'Band rows',
    how: 'Band round a door handle or a desk leg. Pull the elbows back past your ribs, squeeze, let it out slowly. About 15.',
    posture: 'standing',
    kind: 'strength',
    equipment: 'band',
    strain: ['shoulders'],
    prop: 'post',
    hold: 'bandAnchor',
    beat: 1400,
    poses: [
      pose(SIDE, { ...both('lEl', 'rEl', [122, 82]), ...both('lHa', 'rHa', [144, 84]) }),
      pose(SIDE, { neck: [98, 56], ...both('lEl', 'rEl', [84, 86]), ...both('lHa', 'rHa', [104, 84]) }),
    ],
  },
  {
    id: 'hang',
    name: 'Dead hang',
    how: 'Hang from the bar with straight arms, shoulders relaxed, toes down if you need them. Twenty to thirty seconds, rest, again.',
    posture: 'standing',
    kind: 'strength',
    equipment: 'bar',
    strain: ['shoulders', 'wrists'],
    prop: 'bar',
    beat: 2200,
    poses: [pose(FRONT, {
        head: [100, 52],
        neck: [100, 70],
        lSh: [88, 72],
        rSh: [112, 72],
        lEl: [86, 42],
        rEl: [114, 42],
        lHa: [88, 14],
        rHa: [112, 14],
        pelvis: [100, 124],
        lHip: [93, 126],
        rHip: [107, 126],
        lKn: [93, 158],
        rKn: [107, 158],
        lAn: [94, 182],
        rAn: [106, 182],
        lToe: [92, 187],
        rToe: [108, 187],
      }), lifted(pose(FRONT, {
        head: [100, 52],
        neck: [100, 70],
        lSh: [88, 72],
        rSh: [112, 72],
        lEl: [86, 42],
        rEl: [114, 42],
        lHa: [88, 14],
        rHa: [112, 14],
        pelvis: [100, 124],
        lHip: [93, 126],
        rHip: [107, 126],
        lKn: [93, 158],
        rKn: [107, 158],
        lAn: [94, 182],
        rAn: [106, 182],
        lToe: [92, 187],
        rToe: [108, 187],
      }), -5, ['lHa', 'rHa'])],
  },
  {
    id: 'curls',
    name: 'Curls',
    how: 'A weight in each hand, elbows at your sides. Curl up, lower slowly. About 12.',
    posture: 'standing',
    kind: 'strength',
    equipment: 'dumbbells',
    strain: ['wrists'],
    hold: 'dumbbells',
    beat: 1300,
    poses: [FRONT, pose(FRONT, { lHa: [82, 62], rHa: [118, 62] })],
  },
  {
    id: 'press',
    name: 'Overhead press',
    how: 'Weights at your shoulders, press straight up, lower with control. About 10.',
    posture: 'standing',
    kind: 'strength',
    equipment: 'dumbbells',
    strain: ['shoulders', 'back'],
    hold: 'dumbbells',
    beat: 1500,
    poses: [
      pose(FRONT, { lEl: [72, 76], lHa: [76, 56], rEl: [128, 76], rHa: [124, 56] }),
      pose(FRONT, { lEl: [78, 36], lHa: [84, 12], rEl: [122, 36], rHa: [116, 12] }),
    ],
  },
  {
    id: 'carry',
    name: 'Farmer\u2019s carry',
    how: 'A weight in each hand, arms long, shoulders back. Walk tall around the room for the minute.',
    posture: 'standing',
    kind: 'strength',
    equipment: 'dumbbells',
    strain: ['back'],
    hold: 'dumbbells',
    beat: 560,
    poses: [
      pose(SIDE, { lKn: [108, 148], lAn: [114, 180], lToe: [126, 184], rKn: [96, 150], rAn: [84, 178], rToe: [94, 186], lEl: [102, 86], lHa: [104, 112], rEl: [99, 86], rHa: [100, 112] }),
      pose(SIDE, { rKn: [108, 148], rAn: [114, 180], rToe: [126, 184], lKn: [96, 150], lAn: [84, 178], lToe: [94, 186], lEl: [102, 86], lHa: [104, 112], rEl: [99, 86], rHa: [100, 112] }),
    ],
  },
  {
    id: 'sideleg',
    name: 'Side leg raises',
    how: 'A hand on the desk if you like. Lift one leg out to the side, lower slowly. Ten each side.',
    posture: 'standing',
    kind: 'strength',
    equipment: 'ankle',
    strain: ['hips', 'balance'],
    hold: 'ankle',
    beat: 1300,
    poses: [
      pose(FRONT, { lEl: [78, 90], lHa: [92, 112], rEl: [122, 90], rHa: [108, 112] }),
      pose(FRONT, { lEl: [78, 90], lHa: [92, 112], rEl: [122, 90], rHa: [108, 112], head: [96, 38], neck: [98, 56], rKn: [122, 148], rAn: [138, 176], rToe: [146, 180] }),
    ],
  },
  {
    id: 'kickback',
    name: 'Kickbacks',
    how: 'Hands on the desk. Push one leg straight back, squeeze, return. Ten each leg.',
    posture: 'standing',
    kind: 'strength',
    equipment: 'ankle',
    strain: ['back', 'balance'],
    prop: 'desk',
    hold: 'ankle',
    beat: 1300,
    poses: [
      pose(SIDE, { ...both('lEl', 'rEl', [116, 86]), ...both('lHa', 'rHa', [134, 106]) }),
      pose(SIDE, { ...both('lEl', 'rEl', [116, 86]), ...both('lHa', 'rHa', [134, 106]), rKn: [90, 146], rAn: [72, 170], rToe: [66, 178] }),
    ],
  },
  {
    id: 'kbdeadlift',
    name: 'Kettlebell deadlift',
    how: 'Bell between your feet. Hips back, flat back, stand up tall squeezing the glutes. About 10.',
    posture: 'standing',
    kind: 'strength',
    equipment: 'kettlebell',
    strain: ['back'],
    hold: 'kettlebell',
    beat: 1600,
    poses: [
      pose(SIDE, { ...both('lEl', 'rEl', [101, 86]), ...both('lHa', 'rHa', [102, 112]) }),
      pose(SIDE, {
        head: [138, 72],
        neck: [126, 84],
        ...both('lSh', 'rSh', [126, 86]),
        ...both('lEl', 'rEl', [124, 112]),
        ...both('lHa', 'rHa', [122, 138]),
        pelvis: [84, 118],
        ...both('lHip', 'rHip', [84, 118]),
        lKn: [103, 150],
        rKn: [98, 150],
      }),
    ],
  },
  {
    id: 'stepup',
    name: 'Step-ups',
    how: 'Step up with one foot, bring the other up, step down. Change the leading leg halfway. Stairs work too.',
    posture: 'standing',
    kind: 'cardio',
    equipment: 'step',
    strain: ['knees', 'balance'],
    prop: 'step',
    beat: 900,
    poses: [
      SIDE,
      pose(SIDE, { rKn: [116, 140], rAn: [122, 158], rToe: [134, 160] }),
      moved(SIDE, 22, -26),
      pose(SIDE, { rKn: [116, 140], rAn: [122, 158], rToe: [134, 160] }),
    ],
  },
  {
    id: 'bridge',
    name: 'Glute bridge',
    how: 'On your back, knees bent, feet flat. Lift the hips until knees, hips and shoulders line up. Hold, lower. About 12.',
    posture: 'standing',
    kind: 'strength',
    equipment: 'mat',
    strain: ['back'],
    prop: 'mat',
    beat: 1500,
    poses: [BRIDGE_DOWN, BRIDGE_UP],
  },
  {
    id: 'plank',
    name: 'Forearm plank',
    how: 'Forearms on the floor, body in one straight line from head to heels. Hold while it is comfortable, rest, again.',
    posture: 'standing',
    kind: 'strength',
    equipment: 'mat',
    strain: ['back', 'shoulders'],
    prop: 'mat',
    beat: 2200,
    poses: [PLANK, moved(PLANK, 0, -1.5)],
  },
  {
    id: 'childpose',
    name: 'Table to child\u2019s pose',
    how: 'On hands and knees. Breathe out and sit the hips back onto the heels, arms long in front, forehead down; breathe in and come forward again. Slowly, then rest in the last one.',
    posture: 'standing',
    kind: 'yoga',
    equipment: 'mat',
    strain: ['knees'],
    prop: 'mat',
    beat: 3000,
    poses: [
      TABLETOP,
      pose(TABLETOP, {
        head: [146, 176],
        neck: [132, 170],
        ...both('lSh', 'rSh', [130, 171]),
        lEl: [156, 180],
        rEl: [152, 180],
        lHa: [180, 184],
        rHa: [176, 184],
        pelvis: [80, 166],
        ...both('lHip', 'rHip', [80, 166]),
        lKn: [114, 182],
        rKn: [110, 182],
        lAn: [78, 184],
        rAn: [74, 184],
        lToe: [68, 186],
        rToe: [64, 186],
      }),
    ],
  },
  {
    id: 'downdog',
    name: 'Downward dog',
    how: 'From hands and knees, tuck the toes and lift the hips up and back into an upside-down V. Knees can stay bent, heels need not touch. Five breaths, down, again.',
    posture: 'standing',
    kind: 'yoga',
    equipment: 'mat',
    strain: ['wrists', 'shoulders'],
    prop: 'mat',
    beat: 3000,
    poses: [
      TABLETOP,
      pose(TABLETOP, {
        head: [146, 160],
        neck: [142, 148],
        ...both('lSh', 'rSh', [144, 150]),
        lEl: [152, 167],
        rEl: [148, 167],
        pelvis: [104, 108],
        ...both('lHip', 'rHip', [104, 108]),
        lKn: [90, 146],
        rKn: [86, 146],
        lAn: [74, 182],
        rAn: [70, 182],
        lToe: [84, 186],
        rToe: [80, 186],
      }),
    ],
  },
  {
    id: 'sphinx',
    name: 'Sphinx',
    how: 'Lie on your front, elbows under the shoulders. Press into the forearms and lift the chest, shoulders away from the ears, hips heavy. Thirty seconds, down, again.',
    posture: 'standing',
    kind: 'yoga',
    equipment: 'mat',
    strain: ['back'],
    prop: 'mat',
    beat: 3000,
    poses: [
      PRONE,
      pose(PRONE, {
        head: [160, 142],
        neck: [146, 156],
        ...both('lSh', 'rSh', [144, 158]),
        lEl: [148, 183],
        rEl: [144, 183],
      }),
    ],
  },
  {
    id: 'lowlunge',
    name: 'Low lunge',
    how: 'One foot forward, the back knee down on the mat. Arms up, and ease the hips forward until the front of the back hip opens. Five breaths a side, twice.',
    posture: 'standing',
    kind: 'yoga',
    equipment: 'mat',
    strain: ['knees', 'hips'],
    prop: 'mat',
    beat: 3000,
    poses: [
      pose(SIDE, {
        head: [104, 76],
        neck: [104, 94],
        ...both('lSh', 'rSh', [104, 98]),
        ...both('lEl', 'rEl', [106, 72]),
        ...both('lHa', 'rHa', [108, 48]),
        pelvis: [104, 150],
        ...both('lHip', 'rHip', [104, 150]),
        rKn: [136, 148],
        rAn: [138, 182],
        rToe: [150, 186],
        lKn: [80, 182],
        lAn: [44, 184],
        lToe: [36, 186],
      }),
      pose(SIDE, {
        head: [110, 82],
        neck: [110, 100],
        ...both('lSh', 'rSh', [110, 104]),
        ...both('lEl', 'rEl', [112, 78]),
        ...both('lHa', 'rHa', [114, 54]),
        pelvis: [112, 156],
        ...both('lHip', 'rHip', [112, 156]),
        rKn: [142, 150],
        rAn: [138, 182],
        rToe: [150, 186],
        lKn: [84, 182],
        lAn: [48, 184],
        lToe: [40, 186],
      }),
    ],
  },
  {
    id: 'supinetwist',
    name: 'Lying twist',
    how: 'On your back, knees bent, arms out wide. Let both knees fall slowly to one side and turn your head the other way. Thirty seconds, back through the middle, the other side.',
    posture: 'standing',
    kind: 'yoga',
    equipment: 'mat',
    strain: ['back'],
    prop: 'mat',
    beat: 3000,
    poses: [BRIDGE_DOWN, pose(BRIDGE_DOWN, { lKn: [130, 174], rKn: [126, 178], lAn: [150, 182], rAn: [146, 183] })],
  },
  {
    id: 'skip',
    name: 'Skipping',
    how: 'Small, light jumps on the balls of your feet. Rest whenever you need to; keep moving for the minute.',
    posture: 'standing',
    kind: 'cardio',
    equipment: 'rope',
    strain: ['impact', 'knees', 'ankles'],
    hold: 'rope',
    beat: 380,
    poses: [
      pose(FRONT, { lEl: [80, 88], rEl: [120, 88], lHa: [74, 108], rHa: [126, 108] }),
      moved(pose(FRONT, { lEl: [80, 88], rEl: [120, 88], lHa: [74, 108], rHa: [126, 108] }), 0, -10),
    ],
  },
  {
    id: 'seatcurl',
    name: 'Seated curls',
    how: 'Sit tall, a weight in each hand, elbows at your sides. Curl up, lower slowly. About 12.',
    posture: 'seated',
    kind: 'strength',
    equipment: 'dumbbells',
    strain: ['wrists'],
    prop: 'chair',
    hold: 'dumbbells',
    beat: 1300,
    poses: [
      pose(SEATED, { ...both('lEl', 'rEl', [96, 94]), ...both('lHa', 'rHa', [104, 120]) }),
      pose(SEATED, { ...both('lEl', 'rEl', [96, 94]), ...both('lHa', 'rHa', [106, 70]) }),
    ],
  },
  {
    id: 'seatlegw',
    name: 'Weighted leg extensions',
    how: 'Ankle weights on. Straighten one leg until level, hold for three, lower. Ten each leg.',
    posture: 'seated',
    kind: 'strength',
    equipment: 'ankle',
    strain: ['knees'],
    prop: 'chair',
    hold: 'ankle',
    beat: 1600,
    poses: [SEATED, pose(SEATED, { lAn: [170, 118], lToe: [176, 106] })],
  },
]

/**
 * How the figure is drawn: each part of the body as a thick, round-ended
 * stroke between two joints, in drawing order. Thick rather than stick-thin so
 * the figure reads as a body — a pictogram, like a sign — while staying a
 * shape that can be moved between poses smoothly, which a picture could not.
 *
 * The far side (`l`) is drawn first so the body covers it; in a side view it is
 * also drawn a shade darker, which is what makes two legs read as two.
 */
export const BODY: Array<{ from: Joint; to: Joint; side: 'l' | 'r' | 'c'; width: number }> = [
  { from: 'lHip', to: 'lKn', side: 'l', width: 13 },
  { from: 'lKn', to: 'lAn', side: 'l', width: 10 },
  { from: 'lAn', to: 'lToe', side: 'l', width: 7 },
  { from: 'lSh', to: 'lEl', side: 'l', width: 10 },
  { from: 'lEl', to: 'lHa', side: 'l', width: 8 },
  { from: 'neck', to: 'pelvis', side: 'c', width: 20 },
  // The same widths as the arm and thigh they join, so the round ends of the
  // shoulders and hips fall exactly inside the limbs instead of bulging.
  { from: 'lSh', to: 'rSh', side: 'c', width: 10 },
  { from: 'lHip', to: 'rHip', side: 'c', width: 13 },
  { from: 'rHip', to: 'rKn', side: 'r', width: 13 },
  { from: 'rKn', to: 'rAn', side: 'r', width: 10 },
  { from: 'rAn', to: 'rToe', side: 'r', width: 7 },
  { from: 'rSh', to: 'rEl', side: 'r', width: 10 },
  { from: 'rEl', to: 'rHa', side: 'r', width: 8 },
]

/** The head's radius, to go with `BODY`. */
export const HEAD_R = 13

/** The furniture behind an exercise, as SVG path data. */
export function propPaths(prop: Exercise['prop']): string[] {
  switch (prop) {
    case 'chair':
    case 'gaze':
      return ['M78 126 L136 126', 'M78 126 L78 66', 'M82 126 L82 186', 'M132 126 L132 186']
    case 'wall':
      return ['M162 14 L162 187']
    case 'desk':
      return ['M128 108 L188 108', 'M182 108 L182 187']
    case 'bar':
      return ['M40 12 L160 12', 'M44 12 L44 4', 'M156 12 L156 4']
    case 'step':
      return ['M112 161 L172 161 L172 187']
    case 'mat':
      return ['M22 185 L178 185']
    case 'post':
      return ['M186 70 L186 187']
    default:
      return []
  }
}

/**
 * What the figure holds, as SVG path data, for a figure whose joints are at
 * `at`. Recomputed every frame, so a band stretches and a weight rises with
 * the hand holding it.
 */
export function holdPaths(hold: Hold | undefined, at: (joint: Joint) => [number, number]): string[] {
  const p = ([x, y]: [number, number]) => `${x.toFixed(1)} ${y.toFixed(1)}`
  const l = at('lHa')
  const r = at('rHa')
  switch (hold) {
    case 'band':
      return [`M${p(l)} L${p(r)}`]
    case 'bandAnchor':
      return [`M${p(l)} L186 88`, `M${p(r)} L186 88`]
    case 'dumbbells':
      return [l, r].map(([x, y]) => `M${p([x - 6, y])} L${p([x + 6, y])}`)
    case 'ankle':
      return [at('lAn'), at('rAn')].map(([x, y]) => `M${p([x - 4, y - 3])} L${p([x + 4, y - 3])}`)
    case 'kettlebell': {
      const x = (l[0] + r[0]) / 2
      const y = Math.max(l[1], r[1]) + 9
      return [`M${p([x - 7, y])} a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0`]
    }
    case 'rope': {
      // A loop from hand to hand passing just under the feet, wherever they are.
      const feet = Math.max(at('lToe')[1], at('rToe')[1]) + 3
      const control = 2 * feet - (l[1] + r[1]) / 2
      return [`M${p(l)} Q100 ${control.toFixed(1)} ${p(r)}`]
    }
    default:
      return []
  }
}

export function exercise(id: string): Exercise | undefined {
  return EXERCISES.find((e) => e.id === id)
}

/** What somebody has, what they want left alone, and the kinds they would rather not do. */
export interface RoutineFilter {
  equipment?: readonly string[]
  avoid?: readonly string[]
  kindsOff?: readonly string[]
}

/** Whether an exercise is one this person can do and wants to. */
export function suits(ex: Exercise, filter: RoutineFilter = {}): boolean {
  if (ex.equipment && !(filter.equipment ?? []).includes(ex.equipment)) return false
  if (ex.kind !== 'rest' && (filter.kindsOff ?? []).includes(ex.kind)) return false
  return !(ex.strain ?? []).some((s) => (filter.avoid ?? []).includes(s))
}

/**
 * Every exercise that suits you for a posture, in a random order: the first is
 * the break, and "another exercise" walks down the rest.
 *
 * One exercise for the whole break — a list of five in five minutes was a
 * routine to follow rather than a break to take. Filtered by what you have and
 * what you are avoiding; the walk and resting the eyes strain nothing, so the
 * list is never empty however much is being avoided.
 */
export function pickChoices(
  posture: BreakPosture,
  filter: RoutineFilter = {},
  random: () => number = Math.random,
  previous?: string
): string[] {
  const list = EXERCISES.filter((e) => e.posture === posture && suits(e, filter)).map((e) => e.id)
  // A plain shuffle, every break on its own: each exercise equally likely to
  // come first — except the one from the break before, which goes last, so
  // the same exercise never comes twice in a row. Nothing else is remembered.
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return previous && list.includes(previous) ? [...list.filter((id) => id !== previous), previous] : list
}

/**
 * The exercises in rounds, like a shuffled deck: every one that suits you comes
 * up once, in a random order, before any comes up again, and when the round is
 * used up a new one is shuffled.
 *
 * `round` is what is still to come this round, in order, and is kept by the
 * caller between breaks; an exercise leaves it when a break with it ends (see
 * `playedInRound`), not when it is offered, so one put off with "not now" or
 * passed over with "another exercise" still comes up later in the round. What
 * no longer suits you is dropped from it, and what newly does waits for the
 * next round. A new round never starts with `previous`, so the turn of a round
 * cannot repeat the exercise just done.
 *
 * Returns the break's list (the rest of the round first, so "another exercise"
 * walks through what has not been done yet, then the round's done ones) and
 * the round to keep.
 */
export function dealChoices(
  posture: BreakPosture,
  filter: RoutineFilter,
  round: readonly string[],
  random: () => number = Math.random,
  previous?: string
): { choices: string[]; round: string[] } {
  const suitable = pickChoices(posture, filter, random)
  let rest = round.filter((id) => suitable.includes(id))
  if (!rest.length) rest = pickChoices(posture, filter, random, previous)
  const done = suitable.filter((id) => !rest.includes(id))
  return { choices: [...rest, ...done], round: rest }
}

/** The round with `played` taken out of it, after a break with it ended. */
export function playedInRound(round: readonly string[], played: string | undefined): string[] {
  return round.filter((id) => id !== played)
}
