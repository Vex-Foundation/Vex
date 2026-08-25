// Lexical path normalisation, flavour-aware, matching Node's `path.posix` and
// `path.win32` byte for byte.
//
// WHY THIS EXISTS. The two Node owners of the config directory build their
// platform defaults with `path.join`, and `path.join` NORMALISES: it resolves
// `.` and `..` segments lexically, collapses repeated separators, and drops a
// trailing separator on the base. Go's `path.Clean` matches the posix half of
// that, but `path/filepath` is HOST-flavoured - on a Linux builder it would
// join a windows case with `/` - so neither stdlib package can answer for a
// TARGET platform the way the contract requires.
//
// The endpoint discriminator is a SHA-256 over the resolved directory, so a
// single segment resolved differently on one side of the wire is a bridge that
// dials a path the app never bound. `XDG_CONFIG_HOME=/home/alice/../vex-x` is
// a legal, ordinary value; Node resolved it to `/home/vex-x/vex` while a
// naive concatenation produced `/home/alice/../vex-x/vex`, and the two hash
// differently. That is the defect this file closes.
//
// The algorithms below are a deliberate re-derivation of the semantics Node
// documents and the golden vectors pin (contract section 1.1.1). They are held
// to Node's actual output by the `configDir` vectors, which all three
// implementations run as the same table.
//
// NOT USED for `VEX_CONFIG_DIR`: an accepted override is returned VERBATIM,
// because the hash is over exactly those bytes and a cleanup rule invented on
// one side is a different endpoint. Only the JOINED platform defaults
// normalise, and that asymmetry is itself a vector.
package configdir

import "strings"

// isPosixSep reports the one posix separator.
func isPosixSep(b byte) bool { return b == '/' }

// isWinSep reports either separator Windows accepts. A forward slash is a
// legal Windows separator and normalisation converts it to a backslash.
func isWinSep(b byte) bool { return b == '\\' || b == '/' }

// isDriveLetter reports a Windows device root (`C:`), ASCII only.
func isDriveLetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// normalizeSegments resolves `.` and `..` and collapses repeated separators in
// the ROOTLESS remainder of a path.
//
// allowAboveRoot decides what happens to a `..` that would escape: a relative
// path keeps it (`../x` is meaningful), an absolute one discards it (`/..` is
// `/`). sep is the separator to emit.
//
// The state machine tracks a run of dots rather than splitting into a slice:
// splitting would allocate per segment and, more importantly, would lose the
// distinction between the segment `..` and a segment that merely BEGINS with
// two dots (`..config` is an ordinary name).
func normalizeSegments(path string, allowAboveRoot bool, sep byte, isSep func(byte) bool) string {
	var res strings.Builder
	lastSegmentLength := 0
	lastSlash := -1
	dots := 0
	var code byte

	for i := 0; i <= len(path); i++ {
		if i < len(path) {
			code = path[i]
		} else if isSep(code) {
			break
		} else {
			code = sep
		}

		switch {
		case isSep(code):
			if lastSlash == i-1 || dots == 1 {
				// An empty segment (repeated separator) or a bare `.`: both
				// collapse to nothing.
			} else if dots == 2 {
				current := res.String()
				if len(current) < 2 || lastSegmentLength != 2 ||
					current[len(current)-1] != '.' || current[len(current)-2] != '.' {
					if len(current) > 2 {
						if idx := len(current) - lastSegmentLength - 1; idx == -1 {
							res.Reset()
							lastSegmentLength = 0
						} else {
							trimmed := current[:idx]
							res.Reset()
							res.WriteString(trimmed)
							lastSegmentLength = len(trimmed) - 1 - strings.LastIndexByte(trimmed, sep)
						}
						lastSlash = i
						dots = 0
						continue
					} else if len(current) != 0 {
						res.Reset()
						lastSegmentLength = 0
						lastSlash = i
						dots = 0
						continue
					}
				}
				if allowAboveRoot {
					if res.Len() > 0 {
						res.WriteByte(sep)
					}
					res.WriteString("..")
					lastSegmentLength = 2
				}
			} else {
				if res.Len() > 0 {
					res.WriteByte(sep)
				}
				res.WriteString(path[lastSlash+1 : i])
				lastSegmentLength = i - lastSlash - 1
			}
			lastSlash = i
			dots = 0
		case code == '.' && dots != -1:
			dots++
		default:
			dots = -1
		}
	}
	return res.String()
}

// normalizePosix is `path.posix.normalize`.
func normalizePosix(value string) string {
	if len(value) == 0 {
		return "."
	}
	absolute := value[0] == '/'
	trailingSeparator := value[len(value)-1] == '/'

	normalized := normalizeSegments(value, !absolute, '/', isPosixSep)
	if len(normalized) == 0 {
		if absolute {
			return "/"
		}
		if trailingSeparator {
			return "./"
		}
		return "."
	}
	if trailingSeparator {
		normalized += "/"
	}
	if absolute {
		return "/" + normalized
	}
	return normalized
}

// JoinPosix is `path.posix.join`: concatenate the non-empty parts with one
// separator, then normalise the result.
func JoinPosix(parts ...string) string {
	var joined string
	first := true
	for _, part := range parts {
		if part == "" {
			continue
		}
		if first {
			joined = part
			first = false
		} else {
			joined += "/" + part
		}
	}
	if first {
		return "."
	}
	return normalizePosix(joined)
}

// normalizeWindows is `path.win32.normalize`.
//
// The root is parsed FIRST and excluded from segment resolution, because the
// three Windows roots are not segments: a UNC prefix (`\\server\share`), a
// device root (`C:`) and a bare rooted path (`\`) each survive `..` that a
// plain segment walk would eat. Losing the UNC prefix would redirect the
// config directory from a file server to the local disk.
func normalizeWindows(value string) string {
	if len(value) == 0 {
		return "."
	}
	rootEnd := 0
	device := ""
	hasDevice := false
	absolute := false

	code := value[0]
	if len(value) == 1 {
		if isWinSep(code) {
			return `\`
		}
		return value
	}

	if isWinSep(code) {
		absolute = true
		if isWinSep(value[1]) {
			// Possible UNC: `\\server\share`. Anything short of a complete
			// server AND share is an ordinary rooted path.
			j := 2
			last := 2
			for j < len(value) && !isWinSep(value[j]) {
				j++
			}
			if j < len(value) && j != last {
				server := value[last:j]
				last = j
				for j < len(value) && isWinSep(value[j]) {
					j++
				}
				if j < len(value) && j != last {
					last = j
					for j < len(value) && !isWinSep(value[j]) {
						j++
					}
					if j == len(value) || j != last {
						switch {
						case server == "." || server == "?":
							// The DEVICE NAMESPACE (`\\.\` or `\\?\`), not a
							// UNC share. Its root is the four-byte prefix,
							// so what follows is an ordinary segment walk.
							device = `\\` + server
							hasDevice = true
							rootEnd = 4
							colonIndex := strings.IndexByte(value, ':')
							if colonIndex >= 4 {
								possibleDevice := value[4 : colonIndex+1]
								if isWindowsReservedName(possibleDevice, len(possibleDevice)-1) {
									device = `\\?\` + possibleDevice
									rootEnd = 4 + len(possibleDevice)
								}
							}
						case j == len(value):
							// The whole value IS the UNC root; it keeps a
							// trailing separator, as Node emits it.
							return `\\` + server + `\` + value[last:] + `\`
						default:
							device = `\\` + server + `\` + value[last:j]
							hasDevice = true
							rootEnd = j
						}
					}
				}
			}
		} else {
			rootEnd = 1
		}
	} else if colonIndex := strings.IndexByte(value, ':'); colonIndex > 0 {
		if isDriveLetter(code) && colonIndex == 1 {
			device = value[:2]
			hasDevice = true
			rootEnd = 2
			if len(value) > 2 && isWinSep(value[2]) {
				absolute = true
				rootEnd = 3
			}
		} else if isWindowsReservedName(value, colonIndex) {
			// `CON:`, `LPT1:` and friends name a DEVICE, not a directory.
			device = value[:colonIndex+1]
			hasDevice = true
			rootEnd = colonIndex + 1
		}
	}

	tail := ""
	if rootEnd < len(value) {
		tail = normalizeSegments(value[rootEnd:], !absolute, '\\', isWinSep)
	}
	if len(tail) == 0 && !absolute {
		tail = "."
	}
	if len(tail) > 0 && isWinSep(value[len(value)-1]) {
		tail += `\`
	}
	// CVE-2024-36139. A path that was NOT absolute and resolved against NO
	// device must not come out of normalisation looking like one: `.C:C:`
	// normalises to a tail Windows would read as a drive-relative path, so
	// Node prefixes `.\` and this implementation does the same. The bytes
	// feed a SHA-256 that decides which socket the bridge dials, so a guard
	// present on one side only is a different endpoint.
	if !absolute && !hasDevice && strings.Contains(value, ":") {
		if len(tail) >= 2 && isDriveLetter(tail[0]) && tail[1] == ':' {
			return `.\` + tail
		}
		for index := strings.IndexByte(value, ':'); index != -1; index = indexByteFrom(value, ':', index+1) {
			if index == len(value)-1 || isWinSep(value[index+1]) {
				return `.\` + tail
			}
		}
	}
	if isWindowsReservedName(value, strings.IndexByte(value, ':')) {
		return `.\` + device + tail
	}
	if !hasDevice {
		if absolute {
			return `\` + tail
		}
		return tail
	}
	if absolute {
		return device + `\` + tail
	}
	return device + tail
}

// indexByteFrom is strings.IndexByte from an offset, returning an ABSOLUTE
// index so the caller's loop matches Node's `indexOf(needle, from)`.
func indexByteFrom(value string, needle byte, from int) int {
	if from >= len(value) {
		return -1
	}
	found := strings.IndexByte(value[from:], needle)
	if found == -1 {
		return -1
	}
	return from + found
}

// windowsReservedNames are the MS-DOS device names Windows still resolves
// ahead of any directory of the same name. Node keeps this list because a path
// that begins with one is a device reference, not a relative path, and the
// superscript COM/LPT spellings are reached through the same device table.
var windowsReservedNames = map[string]struct{}{
	"CON": {}, "PRN": {}, "AUX": {}, "NUL": {},
	"COM1": {}, "COM2": {}, "COM3": {}, "COM4": {}, "COM5": {},
	"COM6": {}, "COM7": {}, "COM8": {}, "COM9": {},
	"LPT1": {}, "LPT2": {}, "LPT3": {}, "LPT4": {}, "LPT5": {},
	"LPT6": {}, "LPT7": {}, "LPT8": {}, "LPT9": {},
	"COM\u00b9": {}, "COM\u00b2": {}, "COM\u00b3": {},
	"LPT\u00b9": {}, "LPT\u00b2": {}, "LPT\u00b3": {},
}

// isWindowsReservedName mirrors Node's helper, INCLUDING its behaviour for a
// colonIndex of -1: the slice is then everything but the last byte, so `CONx`
// is treated as reserved. That is Node's observable output, and matching it is
// the point of this file.
func isWindowsReservedName(value string, colonIndex int) bool {
	if colonIndex < 0 {
		colonIndex += len(value)
	}
	if colonIndex < 0 || colonIndex > len(value) {
		return false
	}
	_, reserved := windowsReservedNames[strings.ToUpper(value[:colonIndex])]
	return reserved
}

// JoinWindows is `path.win32.join`.
//
// The leading-separator dance is Node's, and it is not cosmetic: after
// concatenation, a first part that was NOT a UNC path but happened to start
// with two separators would be mistaken for one by normalisation, so those
// leading separators are collapsed to a single one. A first part that IS a UNC
// path keeps them.
func JoinWindows(parts ...string) string {
	joined := ""
	firstPart := ""
	haveAny := false
	for _, part := range parts {
		if part == "" {
			continue
		}
		if !haveAny {
			joined = part
			firstPart = part
			haveAny = true
		} else {
			joined += `\` + part
		}
	}
	if !haveAny {
		return "."
	}

	needsReplace := true
	slashCount := 0
	if isWinSep(firstPart[0]) {
		slashCount++
		if len(firstPart) > 1 && isWinSep(firstPart[1]) {
			slashCount++
			if len(firstPart) > 2 {
				if isWinSep(firstPart[2]) {
					slashCount++
				} else {
					// A UNC path in the first part: its prefix is real.
					needsReplace = false
				}
			}
		}
	}
	if needsReplace {
		for slashCount < len(joined) && isWinSep(joined[slashCount]) {
			slashCount++
		}
		if slashCount >= 2 {
			joined = `\` + joined[slashCount:]
		}
	}

	// NORMALISATION IS SKIPPED when any backslash-delimited part names a
	// reserved MS-DOS device (`CON:`, `LPT9:`, ...). Node does this because
	// resolving `..` across a device reference would change WHICH DEVICE the
	// path names, which normalisation has no authority to do; all it does is
	// convert forward slashes. Reproduced here because the resulting bytes are
	// the hash input, and a normalisation this side performed alone would be a
	// different endpoint.
	if containsReservedDevicePart(joined) {
		return strings.ReplaceAll(joined, "/", `\`)
	}
	return normalizeWindows(joined)
}

// containsReservedDevicePart splits on BACKSLASHES ONLY, as Node does at this
// point: a forward slash has not been converted yet, so `a/CON:` is one part.
func containsReservedDevicePart(joined string) bool {
	part := strings.Builder{}
	check := func() bool {
		if part.Len() == 0 {
			return false
		}
		candidate := part.String()
		part.Reset()
		colonIndex := strings.IndexByte(candidate, ':')
		return colonIndex != -1 && isWindowsReservedName(candidate, colonIndex)
	}
	for i := 0; i < len(joined); i++ {
		if joined[i] == '\\' {
			if check() {
				return true
			}
			for i+1 < len(joined) && joined[i+1] == '\\' {
				i++
			}
			continue
		}
		part.WriteByte(joined[i])
	}
	return check()
}

// DirnamePosix is `path.posix.dirname`, and deliberately NOT Go's `path.Dir`.
//
// Go's `path.Dir` runs Clean over the result, so `/a//b/c.sock` becomes
// `/a/b`, while Node returns `/a//b`. The value this is applied to is the
// operator's `VEX_STUDIO_SOCKET` literal, and the resulting parent directory
// is the string the host and the bridge each stat and each report in a
// refusal message, so the two sides must produce the same bytes for the same
// literal rather than each applying its own cleanup.
//
// `path/filepath` cannot answer here at all: it is HOST-flavoured, so a
// Windows builder running the unix-target vectors would split on `\` and
// Clean a posix path into `\tmp\...`. Every path operation in endpoint
// derivation is keyed on the TARGET, never on the machine running the code.
//
// The algorithm is Node's `lib/path.js` posix `dirname`, re-derived: scan
// backwards from the end for the last separator that follows a non-separator
// byte, ignoring index 0 so a rooted path keeps its root.
func DirnamePosix(value string) string {
	if len(value) == 0 {
		return "."
	}
	hasRoot := value[0] == '/'
	end := -1
	matchedSlash := true
	for i := len(value) - 1; i >= 1; i-- {
		if value[i] == '/' {
			if !matchedSlash {
				end = i
				break
			}
		} else {
			matchedSlash = false
		}
	}
	if end == -1 {
		if hasRoot {
			return "/"
		}
		return "."
	}
	if hasRoot && end == 1 {
		return "//"
	}
	return value[:end]
}
