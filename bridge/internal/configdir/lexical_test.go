package configdir

import "testing"

// The join is the seam where this package and the two Node owners could drift
// silently: `path.join` NORMALISES, and the earlier Go implementation
// concatenated. Every expectation below was taken from Node's own
// `path.posix.join` / `path.win32.join` output, so a change that makes this
// table pass by rewriting an expectation is a change that breaks the wire.
//
// The `configDir` golden vectors pin the same rules through the public
// resolver; this table pins the joins directly, so a failure names the
// primitive rather than the platform case that happened to use it.

func TestJoinPosixMatchesNode(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		parts []string
		want  string
	}{
		{"a parent segment resolves against the preceding one",
			[]string{"/home/alice/../vex-x", "vex"}, "/home/vex-x/vex"},
		{"a current-directory segment is dropped",
			[]string{"/home/alice/./cfg", "vex"}, "/home/alice/cfg/vex"},
		{"repeated separators collapse to one",
			[]string{"/srv//state///cfg", "vex"}, "/srv/state/cfg/vex"},
		{"a trailing separator on the base is absorbed",
			[]string{"/srv/state/", "vex"}, "/srv/state/vex"},
		{"a doubled trailing separator is absorbed too",
			[]string{"/srv/state//", "vex"}, "/srv/state/vex"},
		{"a parent segment cannot escape the root",
			[]string{"/a/b/../../../..", "vex"}, "/vex"},
		{"dot segments resolve left to right",
			[]string{"/a/b/./../c/.", "vex"}, "/a/c/vex"},
		{"a leading double separator collapses",
			[]string{"//srv/x", ".config", "vex"}, "/srv/x/.config/vex"},
		{"a segment that merely BEGINS with two dots is an ordinary name",
			[]string{"/home/alice", "..config", "vex"}, "/home/alice/..config/vex"},
		{"three dots are an ordinary name, not a parent segment",
			[]string{"/home/alice", "...", "vex"}, "/home/alice/.../vex"},
		{"empty parts are skipped rather than emitting a separator",
			[]string{"/home/alice", "", "vex"}, "/home/alice/vex"},
		{"a spaced segment is preserved verbatim",
			[]string{"/Users/alice", "Library", "Application Support", "vex"},
			"/Users/alice/Library/Application Support/vex"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := JoinPosix(testCase.parts...); got != testCase.want {
				t.Fatalf("JoinPosix(%q) = %q, Node gives %q", testCase.parts, got, testCase.want)
			}
		})
	}
}

func TestJoinWindowsMatchesNode(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		parts []string
		want  string
	}{
		{"a parent segment resolves against the preceding one",
			[]string{`C:\Users\alice\..\bob\AppData\Roaming`, "vex"},
			`C:\Users\bob\AppData\Roaming\vex`},
		{"repeated and trailing separators collapse",
			[]string{`C:\Users\\alice\AppData\Roaming\`, "vex"},
			`C:\Users\alice\AppData\Roaming\vex`},
		{"forward slashes become backslashes",
			[]string{"C:/Users/alice/AppData/Roaming", "vex"},
			`C:\Users\alice\AppData\Roaming\vex`},
		{"a UNC prefix SURVIVES the join",
			[]string{`\\server\share\roaming`, "vex"},
			`\\server\share\roaming\vex`},
		{"a parent segment inside a UNC path cannot eat the server and share",
			[]string{`\\server\share\a\..\roaming`, "vex"},
			`\\server\share\roaming\vex`},
		{"a bare server-and-share is a root the join extends",
			[]string{`\\server\share`, "vex"}, `\\server\share\vex`},
		{"a UNC base keeps its prefix across several segments",
			[]string{`\\server\share\home`, "AppData", "Roaming", "vex"},
			`\\server\share\home\AppData\Roaming\vex`},
		{"a SINGLE leading separator is drive-rooted, not UNC",
			[]string{`\roaming`, "vex"}, `\roaming\vex`},
		{"a bare drive root keeps exactly one separator",
			[]string{`C:\`, "vex"}, `C:\vex`},
		{"the drive letter's case is preserved, never folded",
			[]string{"c:/x/./y/../z", "vex"}, `c:\x\z\vex`},
		{"a drive-relative base stays drive-relative",
			[]string{"C:x", "vex"}, `C:x\vex`},
		{"a parent segment cannot escape a drive root",
			[]string{`C:\Users\alice\..\..\..`, "AppData", "Roaming", "vex"},
			`C:\AppData\Roaming\vex`},
		{"the DEVICE NAMESPACE prefix is a root, not a UNC share",
			[]string{`\\.\pipe`, "vex"}, `\\.\pipe\vex`},
		{"a reserved device name suppresses normalisation, converting slashes only",
			[]string{`C:\a`, "NUL:", "b//c"}, `C:\a\NUL:\b\\c`},
		{"empty parts are skipped rather than emitting a separator",
			[]string{`C:\Users\alice`, "", "vex"}, `C:\Users\alice\vex`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := JoinWindows(testCase.parts...); got != testCase.want {
				t.Fatalf("JoinWindows(%q) = %q, Node gives %q", testCase.parts, got, testCase.want)
			}
		})
	}
}

// The CVE-2024-36139 guard. A relative win32 path carrying a colon must not
// normalise into something Windows would read as absolute; Node prefixes
// `.\`, and a side that skipped the guard would hash different bytes.
func TestNormalizeWindowsKeepsARelativePathRelative(t *testing.T) {
	for _, testCase := range []struct{ in, want string }{
		{".C:C:", `.\.C:C:`},
		{".:", `.\.:`},
		{"a:", "a:."},
		{"a:b", "a:b"},
		{"C:x", "C:x"},
		{"x/y", `x\y`},
	} {
		if got := normalizeWindows(testCase.in); got != testCase.want {
			t.Fatalf("normalizeWindows(%q) = %q, Node gives %q", testCase.in, got, testCase.want)
		}
	}
}

// isAbsWindows is what decides whether an APPDATA value is USABLE at all, so a
// disagreement with Node's path.win32.isAbsolute silently changes which branch
// of the resolver runs.
func TestIsAbsWindowsMatchesNode(t *testing.T) {
	for _, testCase := range []struct {
		value string
		want  bool
	}{
		{`C:\Users`, true},
		{"C:/Users", true},
		{"C:", false},
		{"C:x", false},
		{`\\server\share`, true},
		{`\roaming`, true},
		{"/roaming", true},
		{"roaming", false},
		{"", false},
		{`\`, true},
		{"1:\\x", false},
	} {
		if got := isAbsWindows(testCase.value); got != testCase.want {
			t.Fatalf("isAbsWindows(%q) = %v, want %v", testCase.value, got, testCase.want)
		}
	}
}
