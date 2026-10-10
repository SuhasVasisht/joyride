// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "JoyrideMac", platforms: [.macOS(.v13)],
    products: [.executable(name: "JoyrideMac", targets: ["JoyrideMac"])],
    targets: [.executableTarget(name: "JoyrideMac")],
    swiftLanguageModes: [.v5]
)
