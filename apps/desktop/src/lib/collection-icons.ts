import {
  ArchiveIcon,
  BookOpenIcon,
  BriefcaseIcon,
  CodeIcon,
  FileTextIcon,
  FlaskConicalIcon,
  FolderIcon,
  GraduationCapIcon,
  HeartIcon,
  HouseIcon,
  ImageIcon,
  LandmarkIcon,
  LightbulbIcon,
  type LucideIcon,
  MailIcon,
  MicroscopeIcon,
  MusicIcon,
  PaletteIcon,
  PlaneIcon,
  PresentationIcon,
  SigmaIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";

/**
 * The first rule whose words appear in a collection's name picks its icon.
 * Order matters: more specific words come before general ones.
 */
const RULES: { words: RegExp; icon: LucideIcon }[] = [
  {
    words: /\b(cv|resume|résumé|career|job|jobs|hiring)\b/i,
    icon: BriefcaseIcon,
  },
  {
    words:
      /\b(thesis|theses|dissertation|phd|msc|master|masters|course|courses|class|classes|lecture|lectures|homework|assignment|assignments|school|university|college|study|studies|exam|exams)\b/i,
    icon: GraduationCapIcon,
  },
  {
    words:
      /\b(poster|posters|slide|slides|talk|talks|presentation|presentations|beamer|keynote)\b/i,
    icon: PresentationIcon,
  },
  {
    words:
      /\b(grant|grants|funding|fellowship|fellowships|scholarship|scholarships|sop)\b/i,
    icon: LandmarkIcon,
  },
  {
    words: /\b(proposal|proposals|idea|ideas|draft|drafts|brainstorm)\b/i,
    icon: LightbulbIcon,
  },
  { words: /\b(letter|letters|mail|email|emails|cover)\b/i, icon: MailIcon },
  {
    words: /\b(research|survey|review|reviews|literature)\b/i,
    icon: MicroscopeIcon,
  },
  {
    words:
      /\b(lab|labs|report|reports|experiment|experiments|science|chemistry|biology|physics)\b/i,
    icon: FlaskConicalIcon,
  },
  {
    words:
      /\b(book|books|chapter|chapters|notes|note|journal|journals|reading)\b/i,
    icon: BookOpenIcon,
  },
  {
    words:
      /\b(paper|papers|article|articles|manuscript|manuscripts|publication|publications|preprint|preprints)\b/i,
    icon: FileTextIcon,
  },
  {
    words:
      /\b(math|maths|mathematics|equation|equations|stats|statistics|proof|proofs)\b/i,
    icon: SigmaIcon,
  },
  {
    words: /\b(code|software|dev|programming|algorithm|algorithms)\b/i,
    icon: CodeIcon,
  },
  {
    words:
      /\b(invoice|invoices|budget|budgets|finance|money|tax|taxes|accounting)\b/i,
    icon: WalletIcon,
  },
  {
    words: /\b(travel|trip|trips|conference|conferences|visa)\b/i,
    icon: PlaneIcon,
  },
  {
    words:
      /\b(team|teams|group|groups|collab|collaboration|collaborations|shared|lab members)\b/i,
    icon: UsersIcon,
  },
  {
    words: /\b(art|design|designs|creative|figures|figure)\b/i,
    icon: PaletteIcon,
  },
  { words: /\b(music|song|songs|audio)\b/i, icon: MusicIcon },
  { words: /\b(photo|photos|image|images|pictures)\b/i, icon: ImageIcon },
  { words: /\b(personal|home|family|private)\b/i, icon: HouseIcon },
  {
    words: /\b(work|office|business|company|client|clients)\b/i,
    icon: BriefcaseIcon,
  },
  {
    words: /\b(archive|archived|old|backup|backups|done|finished)\b/i,
    icon: ArchiveIcon,
  },
  {
    words: /\b(favorite|favorites|favourite|favourites|best|love)\b/i,
    icon: HeartIcon,
  },
];

/** An icon chosen from the collection's name; a plain folder when nothing fits. */
export function collectionIcon(name: string): LucideIcon {
  return RULES.find((rule) => rule.words.test(name))?.icon ?? FolderIcon;
}
