/**
 * File contents editor — CodeMirror 6 (same stack GitHub uses for blob edit).
 *
 * OLD CODE - KEEP UNTIL CONFIRMED WORKING: static Spaces/2 label + Soft wrap toggle
 * with `.active` blue border; highlightActiveLine on.
 */
import {
  useMemo,
  useRef,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import CodeMirror from "@uiw/react-codemirror";
import { githubDark } from "@uiw/codemirror-theme-github";
import { indentWithTab, insertTab } from "@codemirror/commands";
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import {
  isMarkdownFilePath,
  languageExtensionsForPath,
} from "../lib/cm-language";

type IndentMode = "spaces" | "tabs";
type IndentSize = 2 | 4 | 8;
type OpenMenu = "indentMode" | "indentSize" | "wrap" | null;

function Kbd({ children }: { children: string }) {
  return <kbd className="gh-code-editor-kbd">{children}</kbd>;
}

function SelectChevron() {
  return (
    <svg
      className="gh-code-editor-select-chevron"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M4.427 7.427 8 10.999l3.573-3.572a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0l-4.25-4.25a.75.75 0 0 1 1.06-1.06ZM4.427 3.183 8 6.755l3.573-3.572a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.367 4.243a.75.75 0 0 1 1.06-1.06Z"
      />
    </svg>
  );
}

interface EditorSelectProps {
  label: string;
  menuTitle: string;
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  children: ReactNode;
}

function EditorSelect({
  label,
  menuTitle,
  open,
  disabled,
  onToggle,
  children,
}: EditorSelectProps) {
  return (
    <div className={`gh-code-editor-select${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="gh-code-editor-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={onToggle}
      >
        <span>{label}</span>
        <SelectChevron />
      </button>
      {open ? (
        <div className="gh-code-editor-select-menu" role="listbox" aria-label={menuTitle}>
          <div className="gh-code-editor-select-menu-title">{menuTitle}</div>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface FileCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  "aria-label"?: string;
  className?: string;
  /** Grow to fill parent flex/grid height (default true). */
  fillHeight?: boolean;
  /** File path — drives syntax highlighting + markdown preview eligibility. */
  path?: string;
  /** Left-side header slot (Edit | Preview tabs). */
  headerStart?: ReactNode;
  /** When `preview`, show preview pane instead of the code editor. */
  viewMode?: "edit" | "preview";
  /** Markdown preview body (ignored when path is not markdown). */
  preview?: ReactNode;
}

export function FileCodeEditor({
  value,
  onChange,
  disabled = false,
  placeholder,
  "aria-label": ariaLabel = "File contents",
  className = "",
  fillHeight = true,
  path,
  headerStart,
  viewMode = "edit",
  preview,
}: FileCodeEditorProps) {
  /** When true, Tab moves focus; when false (default), Tab indents. */
  const [tabMovesFocus, setTabMovesFocus] = useState(false);
  const escapeArmedRef = useRef(false);
  const [softWrap, setSoftWrap] = useState(true);
  const [indentMode, setIndentMode] = useState<IndentMode>("spaces");
  const [indentSize, setIndentSize] = useState<IndentSize>(2);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [langExts, setLangExts] = useState<Extension[]>([]);
  const headerEndRef = useRef<HTMLDivElement>(null);

  const pathIsMarkdown = isMarkdownFilePath(path);
  const showPreviewPane = viewMode === "preview";
  const toolsDisabled = disabled || showPreviewPane;

  useEffect(() => {
    let cancelled = false;
    setLangExts([]);
    void languageExtensionsForPath(path).then((exts) => {
      if (!cancelled) setLangExts(exts);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = headerEndRef.current;
      if (root && !root.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  const toggleTabFocus = useCallback(() => {
    setTabMovesFocus((v) => !v);
    escapeArmedRef.current = false;
    return true;
  }, []);

  const indentString =
    indentMode === "tabs" ? "\t" : " ".repeat(indentSize);

  const extensions = useMemo(() => {
    const exts: Extension[] = [
      indentUnit.of(indentString),
      EditorState.tabSize.of(indentSize),
      EditorView.editable.of(!disabled),
      EditorState.readOnly.of(disabled),
      EditorView.contentAttributes.of({
        "aria-label": ariaLabel,
      }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Shift-m",
            run: () => toggleTabFocus(),
          },
          {
            key: "Escape",
            run: () => {
              escapeArmedRef.current = true;
              return false;
            },
          },
          {
            key: "Tab",
            run: (view) => {
              if (tabMovesFocus || escapeArmedRef.current) {
                escapeArmedRef.current = false;
                return false;
              }
              if (indentMode === "tabs") {
                return insertTab(view);
              }
              return indentWithTab.run?.(view) ?? false;
            },
            shift: (view) => {
              if (tabMovesFocus || escapeArmedRef.current) {
                escapeArmedRef.current = false;
                return false;
              }
              return indentWithTab.shift?.(view) ?? false;
            },
          },
        ]),
      ),
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "12px",
          backgroundColor: "transparent",
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: "var(--font-mono)",
          backgroundColor: "transparent",
        },
        ".cm-content": {
          padding: "16px 0",
        },
        ".cm-gutters": {
          border: "none",
          backgroundColor: "transparent",
        },
        ".cm-gutterElement": {
          padding: "0 8px 0 12px",
        },
        /* GitHub blob edit: no current-line wash */
        ".cm-activeLine": {
          backgroundColor: "transparent",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "transparent",
        },
        "&.cm-focused": {
          outline: "none",
        },
      }),
      ...langExts,
    ];

    if (softWrap) {
      exts.push(EditorView.lineWrapping);
    }

    if (placeholder) {
      exts.push(cmPlaceholder(placeholder));
    }

    return exts;
  }, [
    ariaLabel,
    disabled,
    indentMode,
    indentSize,
    indentString,
    langExts,
    placeholder,
    softWrap,
    tabMovesFocus,
    toggleTabFocus,
  ]);

  const toggleMenu = (menu: Exclude<OpenMenu, null>) => {
    setOpenMenu((cur) => (cur === menu ? null : menu));
  };

  return (
    <div
      className={`gh-code-editor${fillHeight ? " gh-code-editor--fill" : ""}${className ? ` ${className}` : ""}`}
    >
      <div className="gh-code-editor-header" role="toolbar" aria-label="Editor">
        <div className="gh-code-editor-header-start">{headerStart}</div>
        <div className="gh-code-editor-header-end" ref={headerEndRef}>
          {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
          <span className="gh-code-editor-indent">Spaces<span>2</span></span>
          <button className={`gh-code-editor-tool${softWrap ? " active" : ""}`}>Soft wrap</button>
          */}
          {/* NEW CODE - TESTING: GitHub-style Indent mode / size / wrap selects */}
          <EditorSelect
            label={indentMode === "spaces" ? "Spaces" : "Tabs"}
            menuTitle="Indent mode"
            open={openMenu === "indentMode"}
            disabled={toolsDisabled}
            onToggle={() => toggleMenu("indentMode")}
          >
            <button
              type="button"
              role="option"
              aria-selected={indentMode === "spaces"}
              className={`gh-code-editor-select-option${indentMode === "spaces" ? " is-selected" : ""}`}
              onClick={() => {
                setIndentMode("spaces");
                setOpenMenu(null);
              }}
            >
              Spaces
            </button>
            <button
              type="button"
              role="option"
              aria-selected={indentMode === "tabs"}
              className={`gh-code-editor-select-option${indentMode === "tabs" ? " is-selected" : ""}`}
              onClick={() => {
                setIndentMode("tabs");
                setOpenMenu(null);
              }}
            >
              Tabs
            </button>
          </EditorSelect>
          <EditorSelect
            label={String(indentSize)}
            menuTitle="Indent size"
            open={openMenu === "indentSize"}
            disabled={toolsDisabled}
            onToggle={() => toggleMenu("indentSize")}
          >
            {([2, 4, 8] as const).map((n) => (
              <button
                key={n}
                type="button"
                role="option"
                aria-selected={indentSize === n}
                className={`gh-code-editor-select-option${indentSize === n ? " is-selected" : ""}`}
                onClick={() => {
                  setIndentSize(n);
                  setOpenMenu(null);
                }}
              >
                {n}
              </button>
            ))}
          </EditorSelect>
          <EditorSelect
            label={softWrap ? "Soft wrap" : "No wrap"}
            menuTitle="Line wrap mode"
            open={openMenu === "wrap"}
            disabled={toolsDisabled}
            onToggle={() => toggleMenu("wrap")}
          >
            <button
              type="button"
              role="option"
              aria-selected={!softWrap}
              className={`gh-code-editor-select-option${!softWrap ? " is-selected" : ""}`}
              onClick={() => {
                setSoftWrap(false);
                setOpenMenu(null);
              }}
            >
              No wrap
            </button>
            <button
              type="button"
              role="option"
              aria-selected={softWrap}
              className={`gh-code-editor-select-option${softWrap ? " is-selected" : ""}`}
              onClick={() => {
                setSoftWrap(true);
                setOpenMenu(null);
              }}
            >
              Soft wrap
            </button>
          </EditorSelect>
        </div>
      </div>
      <div className="gh-code-editor-body">
        {showPreviewPane ? (
          <div className="gh-code-editor-preview">
            {pathIsMarkdown ? (
              preview
            ) : (
              <p className="gh-code-editor-renamed-msg">
                The document was renamed without changes.
              </p>
            )}
          </div>
        ) : (
          <div className="gh-code-editor-cm">
            <CodeMirror
              value={value}
              height="100%"
              theme={githubDark}
              extensions={extensions}
              onChange={onChange}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                // OLD CODE - KEEP UNTIL CONFIRMED WORKING
                // highlightActiveLine: true,
                // highlightActiveLineGutter: true,
                // NEW CODE - TESTING: GitHub does not wash the current line
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
                dropCursor: true,
                allowMultipleSelections: true,
                indentOnInput: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: false,
                highlightSelectionMatches: false,
                searchKeymap: true,
              }}
              editable={!disabled}
              readOnly={disabled}
            />
          </div>
        )}
      </div>
      {!showPreviewPane ? (
        <div className="gh-code-editor-a11y" role="status">
          {tabMovesFocus ? (
            <>
              <Kbd>Tab</Kbd> moves focus. Use <Kbd>Control</Kbd> +{" "}
              <Kbd>Shift</Kbd> + <Kbd>m</Kbd> to toggle so <Kbd>Tab</Kbd> inserts
              indent instead.
            </>
          ) : (
            <>
              Use <Kbd>Control</Kbd> + <Kbd>Shift</Kbd> + <Kbd>m</Kbd> to toggle
              the <Kbd>Tab</Kbd> key moving focus. Alternatively, use{" "}
              <Kbd>Esc</Kbd> then <Kbd>Tab</Kbd> to move to the next interactive
              element on the page.
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
