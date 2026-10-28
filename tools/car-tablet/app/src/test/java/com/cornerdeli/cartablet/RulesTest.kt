package com.cornerdeli.cartablet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RulesTest {
    private val start = Rules.Fix(1_000_000, 44.6942, -75.4863, 5f)

    @Test fun keepsTheFirstFix() = assertTrue(Rules.keepFix(null, start))

    @Test fun keepsAMovingFixEveryFiveSeconds() {
        // ~0.0002° latitude ≈ 22 m in 5 s.
        assertTrue(Rules.keepFix(start, start.copy(time = start.time + 5_000, lat = start.lat + 0.0002)))
        assertFalse(Rules.keepFix(start, start.copy(time = start.time + 2_000, lat = start.lat + 0.0002)))
    }

    @Test fun aParkedCarReportsOnceAMinute() {
        assertFalse(Rules.keepFix(start, start.copy(time = start.time + 30_000)))
        assertTrue(Rules.keepFix(start, start.copy(time = start.time + 60_000)))
    }

    @Test fun dropsWildFixes() {
        assertFalse(Rules.keepFix(start, start.copy(time = start.time + 60_000, accuracy = 500f)))
        assertFalse(Rules.keepFix(start, start.copy(time = start.time - 1)))
    }

    @Test fun backoffDoublesToTwoMinutes() {
        assertEquals(0L, Rules.backoffMs(0))
        assertEquals(5_000L, Rules.backoffMs(1))
        assertEquals(10_000L, Rules.backoffMs(2))
        assertEquals(120_000L, Rules.backoffMs(12))
    }

    @Test fun readsThePairingQr() {
        val (server, code) = Rules.parsePairLink("cornerops-car://pair?server=https%3A%2F%2Fdev.ordercornerdeli.com&code=ABCD-EFGH")!!
        assertEquals("https://dev.ordercornerdeli.com", server)
        assertEquals("ABCDEFGH", Rules.normalizeCode(code!!))
        assertNull(Rules.parsePairLink("https://example.com/pair?code=1"))
    }

    @Test fun tidiesTheServerAddress() {
        assertEquals("https://dev.ordercornerdeli.com", Rules.normalizeServer(" dev.ordercornerdeli.com/ "))
        assertEquals("http://192.168.1.237:3000", Rules.normalizeServer("http://192.168.1.237:3000"))
    }

    @Test fun staffPinIsFourToEightDigits() {
        assertTrue(Rules.validStaffPin("2468"))
        assertFalse(Rules.validStaffPin("12a4"))
        assertFalse(Rules.validStaffPin("123"))
    }

    @Test fun money() = assertEquals("$12.05", Rules.money(1205))
}
