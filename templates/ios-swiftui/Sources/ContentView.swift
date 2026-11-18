import SwiftUI

struct Counter {
    private(set) var value = 0
    mutating func increment() { value += 1 }
    mutating func reset() { value = 0 }
}

struct ContentView: View {
    @State private var counter = Counter()

    var body: some View {
        VStack(spacing: 24) {
            Text("Made with Model Chat")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("\(counter.value)")
                .font(.system(size: 72, weight: .bold, design: .rounded))
                .accessibilityIdentifier("count")
            HStack(spacing: 12) {
                Button("Count") { counter.increment() }
                    .buttonStyle(.borderedProminent)
                Button("Reset") { counter.reset() }
                    .buttonStyle(.bordered)
            }
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
