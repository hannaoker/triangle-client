import Foundation

#if !canImport(Darwin)
import Glibc

/// Names the macOS sources use (`Darwin.read`, `renameatx_np`) so the same
/// mailbox helper builds on Linux. macOS keeps the real Darwin module.
enum Darwin {
    static func read(_ fd: Int32, _ buf: UnsafeMutableRawPointer!, _ nbyte: Int) -> Int {
        Glibc.read(fd, buf, nbyte)
    }

    static func write(_ fd: Int32, _ buf: UnsafeRawPointer!, _ nbyte: Int) -> Int {
        Glibc.write(fd, buf, nbyte)
    }

    static func poll(_ fds: UnsafeMutablePointer<pollfd>!, _ nfds: nfds_t, _ timeout: Int32) -> Int32 {
        Glibc.poll(fds, nfds, timeout)
    }

    static func kill(_ pid: Int32, _ sig: Int32) -> Int32 {
        Glibc.kill(pid, sig)
    }

    static func free(_ pointer: UnsafeMutableRawPointer?) {
        Glibc.free(pointer)
    }
}

let MAXNAMLEN = 255
/// Linux `renameat2` exclusive-create flag (`RENAME_NOREPLACE`).
let RENAME_EXCL: UInt32 = 1

@_silgen_name("renameat2")
private func triangleRenameAt2(
    _ olddirfd: Int32,
    _ oldpath: UnsafePointer<CChar>?,
    _ newdirfd: Int32,
    _ newpath: UnsafePointer<CChar>?,
    _ flags: UInt32
) -> Int32

func renameatx_np(
    _ fromfd: Int32,
    _ from: UnsafePointer<CChar>?,
    _ tofd: Int32,
    _ to: UnsafePointer<CChar>?,
    _ flags: UInt32
) -> Int32 {
    triangleRenameAt2(fromfd, from, tofd, to, flags)
}
#endif

/// JSON true/false is a boolean NSNumber, not an integer. macOS uses the
/// CoreFoundation type ID. Linux swift-corelibs-foundation uses the same
/// `__NSCFBoolean` class and does not expose CFBooleanGetTypeID.
func jsonNumberIsBoolean(_ number: NSNumber) -> Bool {
    #if canImport(Darwin)
    CFGetTypeID(number) == CFBooleanGetTypeID()
    #else
    NSStringFromClass(type(of: number)) == "__NSCFBoolean"
    #endif
}
