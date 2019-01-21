package io.appium.espressoserver.test.model

import com.google.gson.Gson

import org.junit.Test

import java.io.IOException
import java.util.ArrayList

import io.appium.espressoserver.lib.model.BackdoorMethodArg
import io.appium.espressoserver.lib.model.MobileBackdoorMethod
import io.appium.espressoserver.lib.model.MobileBackdoorParams
import io.appium.espressoserver.test.assets.Helpers

import io.appium.espressoserver.lib.model.MobileBackdoorParams.InvocationTarget.ACTIVITY
import junit.framework.Assert.fail
import org.junit.Assert.*

class MobileBackdoorMethodTest {

    @Test
    fun `should parse arguments and types for mobile backdoor`() {
        val method = MobileBackdoorMethod()
        method.args = arrayOf(
                BackdoorMethodArg("java.lang.String", "Oh"),
                BackdoorMethodArg("java.lang.Integer", "10"),
                BackdoorMethodArg("int", "20"),
                BackdoorMethodArg("Boolean", "true")
        )
        assertArrayEquals(arrayOf(String::class, Integer::class, Int::class, Boolean::class), method.argumentTypes)
        assertArrayEquals(arrayOf("Oh", 10, 20, true), method.arguments)

    }

    @Test
    fun `should not allow bad argument types`() {
        val method = MobileBackdoorMethod()
        method.args = arrayOf(BackdoorMethodArgs("java.lang.LoL", "Oh"))
        try {
            method.getArgumentTypes()
            fail("expected exception was not occured.")
        } catch (e: Exception) {
            assertTrue(e.getMessage().contains("Class not found: java.lang.Lol")))
        }

    }

    @Test
    fun `should not allow values that are incompatible with provided type`() {
        val method = MobileBackdoorMethod()
        val args = ArrayList()
        val arg1 = BackdoorMethodArg()
        arg1.setType("int")
        arg1.setValue("lol")
        args.add(arg1)
        method.setArgs(args)
        try {
            method.getArguments()
            fail("expected exception was not occured.")
        } catch (e: Exception) {
            assertTrue(e.getMessage().contains("For input string: \"lol\""))
        }

    }

    @Test
    @Throws(IOException::class)
    fun `should parses methods with arguments for provided JSON`() {
        val backdoorMethods = """
            {
              "target": "activity",
              "methods": [
                {
                  "name": "firstMethod",
                  "args": [
                    {
                      "value": "true",
                      "type": "boolean"
                    },
                    {
                      "value": "1",
                      "type": "int"
                    },
                    {
                      "value": "20",
                      "type": "byte"
                    },
                    {
                      "value": "X",
                      "type": "char"
                    }
                  ]
                },
                {
                  "name": "secondMethod",
                  "args": [
                    {
                      "value": true,
                      "type": "boolean"
                    },
                    {
                      "value": 1,
                      "type": "int"
                    },
                    {
                      "value": 20,
                      "type": "byte"
                    },
                    {
                      "value": "X",
                      "type": "Character"
                    },
                    {
                      "value": "Y",
                      "type": "java.lang.String"
                    }
                  ]
                }
              ]
            }
        """.trimIndent()
        //val params = MobileBackdoorParams::class.java!!.cast(Gson().fromJson(backdoorMethods, MobileBackdoorParams::class.java))
        val params = Gson().fromJson(backdoorMethods, MobileBackdoorParams::class)
        val mobileBackdoor = params.getMethods()

        assertEquals(ACTIVITY, params.getTarget())

        val firstMethod = mobileBackdoor.get(0)
        assertEquals("firstMethod", firstMethod.getName())
        assertArrayEquals(arrayOf<Class>(Boolean::class.javaPrimitiveType, Int::class.javaPrimitiveType, Byte::class.javaPrimitiveType, Char::class.javaPrimitiveType), firstMethod.getArgumentTypes())
        assertArrayEquals(arrayOf<Object>(true, 1, 20.toByte(), 'X'), firstMethod.getArguments())

        val secondMethod = mobileBackdoor.get(1)
        assertEquals("secondMethod", secondMethod.getName())
        assertArrayEquals(arrayOf<Class>(Boolean::class.javaPrimitiveType, Int::class.javaPrimitiveType, Byte::class.javaPrimitiveType, Character::class.java, String::class.java), secondMethod.getArgumentTypes())
        assertArrayEquals(arrayOf<Object>(true, 1, 20.toByte(), 'X', "Y"), secondMethod.getArguments())

    }
}