import XCTest
@testable import CounterApp

final class CounterTests: XCTestCase {
    func testIncrementCounts() {
        var counter = Counter()
        counter.increment()
        counter.increment()
        XCTAssertEqual(counter.value, 2)
    }

    func testResetReturnsToZero() {
        var counter = Counter()
        counter.increment()
        counter.reset()
        XCTAssertEqual(counter.value, 0)
    }
}
