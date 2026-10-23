package version

import "runtime"

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

func String() string {
	return Version + " (" + Commit + ", " + BuildDate + ", " + runtime.Version() + ")"
}
